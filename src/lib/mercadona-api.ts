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

export type CartLine = { productId: string; quantity: number };

export type MercadonaCart = {
  id: string;
  lines: CartLine[];
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

function extractLineProductId(line: unknown): string | null {
  if (typeof line !== "object" || line === null) return null;
  const l = line as Record<string, unknown>;
  if (typeof l.product === "object" && l.product !== null) {
    const id = (l.product as Record<string, unknown>).id;
    if (typeof id === "string") return id;
  }
  if (typeof l.product_id === "string") return l.product_id;
  if (typeof l.productId === "string") return l.productId;
  return null;
}

function extractLineQuantity(line: unknown): number | null {
  if (typeof line !== "object" || line === null) return null;
  const q = (line as Record<string, unknown>).quantity;
  return typeof q === "number" ? q : null;
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
  const rawLines = Array.isArray((raw as Record<string, unknown>)?.lines) ? (raw as { lines: unknown[] }).lines : [];
  const lines: CartLine[] = [];
  for (const line of rawLines) {
    const productId = extractLineProductId(line);
    const quantity = extractLineQuantity(line);
    if (productId != null && quantity != null) lines.push({ productId, quantity });
  }
  const id = typeof (raw as Record<string, unknown>)?.id === "string" ? ((raw as Record<string, unknown>).id as string) : customerId;
  return { id, lines, totalCents: extractTotalCents(raw), raw };
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
    lines: lines.map((l) => ({ quantity: l.quantity, product_id: l.productId, sources: [] })),
  };
  const raw = await request(cartUrl(customerId, warehouseId), token, { method: "PUT", body: JSON.stringify(body) });
  const rawLines = Array.isArray((raw as Record<string, unknown>)?.lines) ? (raw as { lines: unknown[] }).lines : [];
  const resultLines: CartLine[] = [];
  for (const line of rawLines) {
    const productId = extractLineProductId(line);
    const quantity = extractLineQuantity(line);
    if (productId != null && quantity != null) resultLines.push({ productId, quantity });
  }
  return { id: cartId, lines: resultLines, totalCents: extractTotalCents(raw), raw };
}

export { MercadonaApiError };
