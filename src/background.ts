// Service worker. Owns the two explicit-click jobs (see [[project-loop]]):
// linking (capture a live Mercadona session) and prepare-on-confirm (the
// actual cart write) — never anything on a timer or on extension load. Also
// reports outcomes straight to Loop's backend itself (not via the Loop page
// relaying), matching the "the extension reports back" framing already
// baked into Loop's schema comments (users.mercadonaStatus, basket_runs).
import { computeCartUpdates, foldCartLines } from "./lib/basket-math";
import { reportBasketRun, reportMercadonaStatus } from "./lib/loop-api";
import { getCart, MercadonaApiError, setCartLines } from "./lib/mercadona-api";
import type { ConfirmPrepareResult, ContentToBackgroundMessage, LoopToExtensionMessage, MercadonaSession } from "./types";

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
    const { lines: updates, processed } = computeCartUpdates(cart.lines, lines);
    const fullLines = foldCartLines(cart.lines, updates);
    const requestPayload = { id: cart.id, lines: fullLines };
    const updated = await setCartLines(session.token, session.customerId, session.warehouseId, cart.id, fullLines);

    const result: ConfirmPrepareResult = {
      status: "ok",
      itemsProcessed: processed,
      requestPayload,
      responseStatus: 200,
      responseBody: updated.raw,
      cartTotalCents: updated.totalCents ?? undefined,
      driftDetected: false,
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

  return false;
});
