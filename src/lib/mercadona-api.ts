// Cart GET/PUT against tienda.mercadona.es's unofficial storefront API, in
// the user's own live browser session (Bearer token captured by
// content/page-hook.ts — see [[project-loop]] in Loop's project memory).
//
// Shapes below are CONFIRMED from reading mercadona-cli's Go source directly
// (documented in Loop's project memory, "Confirmed API shapes"), the same
// source loop-mercadona-adapter's now-retired cart code was built from:
//   - GET  /api/customers/<id>/cart/?lang=&wh=  -> nested product-per-line shape
//   - PUT  same URL, flat body {id, lines:[{quantity,product_id,sources:[]}]},
//     deliberately no version field (backend is eventually consistent).
// The exact field names inside a GET response's `lines[]` (e.g. whether the
// product id sits at `line.product.id` vs `line.product_id`) were not
// independently re-verified against a live account this session — parsing
// below tries the documented nested shape first and falls back defensively.

export const MERCADONA_BASE_URL = "https://tienda.mercadona.es";

import { parseCartLines, type CartLine } from "./cart-lines";

export type { CartLine };

export type MercadonaCart = {
  id: string;
  lines: CartLine[];
  // Lines present in the response that we couldn't parse. Must be 0 before any
  // PUT: the PUT replaces the full list, so an unread line would be deleted.
  unreadableLineCount: number;
  // False when the response carried no `lines` array at all.
  hasLines: boolean;
  totalCents: number | null;
  raw: unknown;
};

class MercadonaApiError extends Error {
  constructor(
    public status: number,
    public body: unknown
  ) {
    super(`mercadona api error: status=${status}`);
  }
}

function cartUrl(customerId: string, warehouseId: string | null) {
  const params = new URLSearchParams({ lang: "es" });
  if (warehouseId) params.set("wh", warehouseId);
  return `${MERCADONA_BASE_URL}/api/customers/${customerId}/cart/?${params.toString()}`;
}

async function request(url: string, token: string, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("json") ? await response.json().catch(() => null) : await response.text();
  if (!response.ok) throw new MercadonaApiError(response.status, body);
  return body;
}

function extractTotalCents(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  const summary = (body as Record<string, unknown>).summary;
  if (typeof summary !== "object" || summary === null) return null;
  const total = (summary as Record<string, unknown>).total;
  if (typeof total === "number") return Math.round(total * 100);
  if (typeof total === "string" && !Number.isNaN(Number(total))) return Math.round(Number(total) * 100);
  return null;
}

export async function getCart(token: string, customerId: string, warehouseId: string | null): Promise<MercadonaCart> {
  const raw = await request(cartUrl(customerId, warehouseId), token);
  const id = typeof (raw as Record<string, unknown>)?.id === "string" ? ((raw as Record<string, unknown>).id as string) : customerId;
  return toCart(id, raw);
}

function toCart(id: string, raw: unknown): MercadonaCart {
  const parsed = parseCartLines(raw);
  return {
    id,
    lines: parsed.lines,
    unreadableLineCount: parsed.unreadableCount,
    hasLines: parsed.hasLines,
    totalCents: extractTotalCents(raw),
    raw,
  };
}

export async function setCartLines(
  token: string,
  customerId: string,
  warehouseId: string | null,
  cartId: string,
  lines: CartLine[]
): Promise<MercadonaCart> {
  const body = {
    id: cartId,
    // Pass back whatever `sources` the line already had; only brand-new lines get [].
    lines: lines.map((l) => ({ quantity: l.quantity, product_id: l.productId, sources: l.sources ?? [] })),
  };
  const raw = await request(cartUrl(customerId, warehouseId), token, { method: "PUT", body: JSON.stringify(body) });
  return toCart(cartId, raw);
}

// --- Catalog (categories + products) ---
//
// Unlike cart, these need no Bearer token — confirmed live against
// https://tienda.mercadona.es/api/categories/ and documented independently
// at https://github.com/datania/mercadona-catalog/blob/main/api.md. So
// catalog sync works even before the account is linked; `wh` just narrows
// pricing/availability to a real warehouse when we have one on hand.
//
// Shape (confirmed live, Aug 2026):
//   GET /api/categories/            -> { results: [{ categories: [{id, name}] }] }  (top-level sections; no products yet)
//   GET /api/categories/<id>/?wh=.. -> { categories: [{ ..., products: [...], categories: [...] }] }
// Products can appear at any depth in that second response's nested
// `categories[]` (Mercadona nests sub-subcategories), so extraction below
// walks the whole tree rather than assuming a fixed depth.

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new MercadonaApiError(response.status, await response.text().catch(() => null));
  return response.json();
}

function categoryDetailUrl(id: number, warehouseId: string | null) {
  const params = new URLSearchParams({ lang: "es" });
  if (warehouseId) params.set("wh", warehouseId);
  return `${MERCADONA_BASE_URL}/api/categories/${id}/?${params.toString()}`;
}

export type CatalogProduct = {
  productId: string;
  displayName: string;
  packaging: string | null;
  imageUrl: string | null;
  unitPriceCents: number | null;
  referencePrice: string | null;
  referenceFormat: string | null;
};

// Level 0 (sections, parentId null) followed by level 1 (subcategories,
// parentId = their section's id) — sections-before-children, since Loop's
// ingest inserts these in array order and product_categories rows FK into
// them. Deliberately not the level-2 nodes products actually live under
// (see the module comment): Mercadona's own site browses by level 1, and
// tagging a product against the level-1 call it was fetched under (in
// getCatalogProducts below) is exact, unlike trusting a product's own
// self-reported `categories[]` (level 0 only, and — per a live sync that
// came up short — not reliably present for every section).
export type CategoryTreeNode = { id: number; name: string; order?: number; parentId?: number };

export async function getCategoryTree(): Promise<CategoryTreeNode[]> {
  const raw = (await getJson(`${MERCADONA_BASE_URL}/api/categories/`)) as {
    results?: { id: number; name: string; order?: number; categories?: { id: number; name: string; order?: number }[] }[];
  };
  const nodes: CategoryTreeNode[] = [];
  for (const section of raw.results ?? []) {
    nodes.push({ id: section.id, name: section.name, order: section.order });
  }
  for (const section of raw.results ?? []) {
    for (const sub of section.categories ?? []) {
      nodes.push({ id: sub.id, name: sub.name, order: sub.order, parentId: section.id });
    }
  }
  return nodes;
}

function parsePriceToCents(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function extractProducts(node: unknown, out: CatalogProduct[]): void {
  if (typeof node !== "object" || node === null) return;
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj.products)) {
    for (const p of obj.products) {
      if (typeof p !== "object" || p === null) continue;
      const product = p as Record<string, unknown>;
      const id = product.id;
      const displayName = product.display_name;
      if (typeof id !== "string" || typeof displayName !== "string") continue;
      const priceInstructions = (product.price_instructions ?? {}) as Record<string, unknown>;
      out.push({
        productId: id,
        displayName,
        packaging: typeof product.packaging === "string" ? product.packaging : null,
        imageUrl: typeof product.thumbnail === "string" ? product.thumbnail : null,
        unitPriceCents: parsePriceToCents(priceInstructions.unit_price),
        referencePrice: typeof priceInstructions.reference_price === "string" ? priceInstructions.reference_price : null,
        referenceFormat: typeof priceInstructions.reference_format === "string" ? priceInstructions.reference_format : null,
      });
    }
  }
  if (Array.isArray(obj.categories)) {
    for (const child of obj.categories) extractProducts(child, out);
  }
}

export async function getCatalogProducts(subcategoryId: number, warehouseId: string | null): Promise<CatalogProduct[]> {
  const detail = await getJson(categoryDetailUrl(subcategoryId, warehouseId));
  const out: CatalogProduct[] = [];
  extractProducts(detail, out);
  return out;
}

export { MercadonaApiError };
