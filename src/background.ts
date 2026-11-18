// Service worker. Owns three explicit-click jobs (see [[project-loop]]):
// linking (capture a live Mercadona session), prepare-on-confirm (the actual
// cart write), and catalog sync (bulk read of categories/products) — never
// anything on a timer or on extension load. Also reports outcomes straight
// to Loop's backend itself (not via the Loop page relaying), matching the
// "the extension reports back" framing already baked into Loop's schema
// comments (users.mercadonaStatus, basket_runs).
import { computeCartUpdates, foldCartLines } from "./lib/basket-math";
import { checkCartDrift, describeDrift, hasDrift, type CartLine } from "./lib/cart-lines";
import { reportBasketRun, reportMercadonaStatus, upsertCatalogEntries } from "./lib/loop-api";
import {
  getCart,
  getCatalogProducts,
  getCategoryTree,
  MercadonaApiError,
  setCartLines,
  type CatalogProduct,
} from "./lib/mercadona-api";
import type {
  ConfirmPrepareResult,
  ContentToBackgroundMessage,
  LoopToExtensionMessage,
  MercadonaSession,
  SyncCatalogResult,
} from "./types";

const MERCADONA_ORIGIN = "https://tienda.mercadona.es";
const LINK_TIMEOUT_MS = 15_000;

async function getStoredSession(): Promise<MercadonaSession | null> {
  const { mercadonaSession } = await chrome.storage.local.get("mercadonaSession");
  return (mercadonaSession as MercadonaSession | undefined) ?? null;
}

async function storeSession(session: MercadonaSession) {
  await chrome.storage.local.set({ mercadonaSession: session });
}

// Resolved by the next session-captured message from the content script.
// Not persisted across a service-worker restart — fine, this only spans a
// single short "click Link, log into Mercadona" interaction.
let pendingLinkResolve: ((session: MercadonaSession) => void) | null = null;

chrome.runtime.onMessage.addListener((message: ContentToBackgroundMessage) => {
  if (message?.type !== "session-captured") return;
  void (async () => {
    const existing = await getStoredSession();
    const session: MercadonaSession = {
      token: message.token,
      customerId: message.customerId,
      warehouseId: message.warehouseId ?? existing?.warehouseId ?? null,
      capturedAt: Date.now(),
    };
    await storeSession(session);
    pendingLinkResolve?.(session);
    pendingLinkResolve = null;
  })();
});

async function ensureMercadonaTabOpen(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: `${MERCADONA_ORIGIN}/*` });
  if (tabs[0]?.id != null) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    // A tab left open from before the session was captured won't have fired
    // a fresh authenticated call for the hook to see — reload so page-hook
    // observes one.
    await chrome.tabs.reload(tabs[0].id);
    return;
  }
  await chrome.tabs.create({ url: MERCADONA_ORIGIN, active: true });
}

async function waitForCapturedSession(timeoutMs: number): Promise<MercadonaSession | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingLinkResolve = null;
      resolve(null);
    }, timeoutMs);
    pendingLinkResolve = (session) => {
      clearTimeout(timer);
      resolve(session);
    };
  });
}

async function handleLinkAccount(loopOrigin: string): Promise<{ linked: boolean }> {
  await ensureMercadonaTabOpen();
  const session = await waitForCapturedSession(LINK_TIMEOUT_MS);
  const linked = session != null;
  await reportMercadonaStatus(loopOrigin, linked).catch(() => null);
  return { linked };
}

async function handleConfirmPrepare(
  loopOrigin: string,
  plannedBasketId: string,
  lines: { listItemId: string; productId: string; quantity: number }[]
): Promise<ConfirmPrepareResult> {
  const session = await getStoredSession();
  if (!session) {
    const result: ConfirmPrepareResult = {
      status: "error",
      itemsProcessed: [],
      requestPayload: null,
      errorMessage: "not_linked",
    };
    await reportBasketRun(loopOrigin, { plannedBasketId, ...result }).catch(() => null);
    return result;
  }

  try {
    const cart = await getCart(session.token, session.customerId, session.warehouseId);

    // The PUT replaces the whole cart. If we couldn't read every existing line
    // (or the response shape changed), writing would silently delete the
    // user's own items — refuse and report instead.
    if (!cart.hasLines || cart.unreadableLineCount > 0) {
      const result: ConfirmPrepareResult = {
        status: "error",
        itemsProcessed: [],
        requestPayload: null,
        responseBody: cart.raw,
        errorMessage: !cart.hasLines ? "cart_shape_unrecognized" : `cart_unreadable_lines:${cart.unreadableLineCount}`,
      };
      await reportBasketRun(loopOrigin, { plannedBasketId, ...result }).catch(() => null);
      return result;
    }

    const { lines: updates, processed } = computeCartUpdates(cart.lines, lines);
    const fullLines = foldCartLines(cart.lines, updates);
    const requestPayload = { id: cart.id, lines: fullLines };
    const updated = await setCartLines(session.token, session.customerId, session.warehouseId, cart.id, fullLines);

    // Check the cart actually holds what we sent. Use the PUT response when it
    // echoes a readable cart; otherwise read it back once.
    let actualLines: CartLine[] | null = null;
    let totalCents = updated.totalCents;
    if (updated.hasLines && updated.unreadableLineCount === 0) {
      actualLines = updated.lines;
    } else {
      const after = await getCart(session.token, session.customerId, session.warehouseId).catch(() => null);
      if (after && after.hasLines && after.unreadableLineCount === 0) {
        actualLines = after.lines;
        totalCents = after.totalCents ?? totalCents;
      }
    }
    const drift = actualLines ? checkCartDrift(fullLines, actualLines) : null;
    const drifted = drift !== null && hasDrift(drift);

    const result: ConfirmPrepareResult = {
      status: drifted ? "partial" : "ok",
      itemsProcessed: processed,
      requestPayload,
      responseStatus: 200,
      responseBody: updated.raw,
      cartTotalCents: totalCents ?? undefined,
      driftDetected: drifted,
      ...(drifted ? { errorMessage: describeDrift(drift!) } : {}),
      ...(drift === null ? { errorMessage: "cart_unverified" } : {}),
    };
    await reportBasketRun(loopOrigin, { plannedBasketId, ...result }).catch(() => null);
    return result;
  } catch (err) {
    const result: ConfirmPrepareResult = {
      status: "error",
      itemsProcessed: [],
      requestPayload: null,
      responseStatus: err instanceof MercadonaApiError ? err.status : undefined,
      responseBody: err instanceof MercadonaApiError ? err.body : undefined,
      errorMessage: err instanceof Error ? err.message : "unknown_error",
    };
    await reportBasketRun(loopOrigin, { plannedBasketId, ...result }).catch(() => null);
    return result;
  }
}

const CATALOG_FETCH_CONCURRENCY = 6;
const CATALOG_PUSH_BATCH_SIZE = 200;
// One retry beyond the initial attempt, for a subcategory whose request
// itself threw (network hiccup, rate limit, transient 5xx) — not for one
// that resolved normally with zero products, which is left alone as a
// genuinely empty Mercadona category. Without this, a transient failure on
// any of the ~150 per-sync requests reads identically to "this category has
// nothing in it" until the next full manual sync.
const CATALOG_FETCH_RETRIES = 1;

async function fetchSubcategoryProducts(
  subcategoryId: number,
  warehouseId: string | null
): Promise<{ subcategoryId: number; products: CatalogProduct[]; failed: boolean }> {
  for (let attempt = 0; attempt <= CATALOG_FETCH_RETRIES; attempt++) {
    try {
      return { subcategoryId, products: await getCatalogProducts(subcategoryId, warehouseId), failed: false };
    } catch {
      if (attempt === CATALOG_FETCH_RETRIES) return { subcategoryId, products: [], failed: true };
    }
  }
  return { subcategoryId, products: [], failed: true };
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Reads Mercadona's whole category tree (both levels, unconditionally —
// see mercadona-api.ts CategoryTreeNode) and every product under each
// level-1 subcategory (public endpoints, no session needed), then
// bulk-upserts into Loop's shared cache. A product can be cross-listed
// under more than one subcategory; a Set per product id merges those
// instead of the last write clobbering the rest, which an earlier version
// of this (that keyed a plain Map by product id per fetch) got wrong.
async function handleSyncCatalog(loopOrigin: string): Promise<SyncCatalogResult> {
  const session = await getStoredSession();
  const warehouseId = session?.warehouseId ?? null;
  try {
    const tree = await getCategoryTree();
    const subcategoryIds = tree.filter((n) => n.parentId != null).map((n) => n.id);

    const perSubcategory = await mapWithConcurrency(subcategoryIds, CATALOG_FETCH_CONCURRENCY, (subcategoryId) =>
      fetchSubcategoryProducts(subcategoryId, warehouseId)
    );
    const categoriesFailed = perSubcategory.filter((r) => r.failed).length;

    const byProductId = new Map<string, CatalogProduct & { categoryIds: Set<number> }>();
    for (const { subcategoryId, products } of perSubcategory) {
      for (const product of products) {
        const existing = byProductId.get(product.productId);
        if (existing) existing.categoryIds.add(subcategoryId);
        else byProductId.set(product.productId, { ...product, categoryIds: new Set([subcategoryId]) });
      }
    }
    const allProducts = [...byProductId.values()];

    if (allProducts.length === 0) {
      // Still worth persisting the tree itself so the sidebar reflects
      // Mercadona's real structure even if every product fetch failed.
      await upsertCatalogEntries(loopOrigin, [], tree);
    }
    for (let i = 0; i < allProducts.length; i += CATALOG_PUSH_BATCH_SIZE) {
      const batch = allProducts.slice(i, i + CATALOG_PUSH_BATCH_SIZE);
      await upsertCatalogEntries(
        loopOrigin,
        batch.map((p) => ({
          productId: p.productId,
          warehouseId: warehouseId ?? undefined,
          displayName: p.displayName,
          packaging: p.packaging,
          imageUrl: p.imageUrl,
          unitPriceCents: p.unitPriceCents,
          referencePrice: p.referencePrice,
          referenceFormat: p.referenceFormat,
          categoryIds: [...p.categoryIds],
        })),
        i === 0 ? tree : undefined
      );
    }

    return {
      status: "ok",
      categoriesScanned: subcategoryIds.length,
      productsUpserted: allProducts.length,
      categoriesFailed,
    };
  } catch (err) {
    return {
      status: "error",
      categoriesScanned: 0,
      productsUpserted: 0,
      categoriesFailed: 0,
      errorMessage: err instanceof Error ? err.message : "unknown_error",
    };
  }
}

chrome.runtime.onMessageExternal.addListener((message: LoopToExtensionMessage, sender, sendResponse) => {
  const loopOrigin = sender.origin;
  if (!loopOrigin) return false;

  if (message.type === "loop:ping") {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return false;
  }

  if (message.type === "loop:link-account") {
    void handleLinkAccount(loopOrigin).then(sendResponse);
    return true;
  }

  if (message.type === "loop:confirm-prepare") {
    void handleConfirmPrepare(loopOrigin, message.plannedBasketId, message.lines).then(sendResponse);
    return true;
  }

  if (message.type === "loop:sync-catalog") {
    void handleSyncCatalog(loopOrigin).then(sendResponse);
    return true;
  }

  return false;
});
