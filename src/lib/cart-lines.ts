// Pure parsing/verification helpers for Mercadona cart line lists. Kept free of
// runtime imports (and of TS-only syntax like parameter properties) so
// `node --test` can load it directly via Node's type stripping.
//
// Why this matters: the cart PUT *replaces* the whole line list, so any line we
// fail to read on the GET would be silently deleted from the user's cart on the
// PUT. parseCartLines therefore reports what it couldn't read instead of
// skipping it, and the caller refuses to write when that count is non-zero.

export type CartLine = {
  productId: string;
  quantity: number;
  // Whatever Mercadona had in the line's `sources` field, passed back untouched
  // on PUT so we don't erase it for lines we merely carry through.
  sources?: unknown[];
};

export type ParsedCartLines = {
  // False when the body had no `lines` array at all — distinct from an empty cart.
  hasLines: boolean;
  lines: CartLine[];
  unreadableCount: number;
};

function extractLineProductId(line: Record<string, unknown>): string | null {
  if (typeof line.product === "object" && line.product !== null) {
    const id = (line.product as Record<string, unknown>).id;
    if (typeof id === "string") return id;
    if (typeof id === "number") return String(id);
  }
  if (typeof line.product_id === "string") return line.product_id;
  if (typeof line.productId === "string") return line.productId;
  return null;
}

function extractLineQuantity(line: Record<string, unknown>): number | null {
  const q = line.quantity;
  if (typeof q === "number" && Number.isFinite(q)) return q;
  if (typeof q === "string" && q.trim() !== "" && Number.isFinite(Number(q))) return Number(q);
  return null;
}

export function parseCartLines(body: unknown): ParsedCartLines {
  const rawLines = (body as Record<string, unknown> | null)?.lines;
  if (!Array.isArray(rawLines)) return { hasLines: false, lines: [], unreadableCount: 0 };

  const lines: CartLine[] = [];
  let unreadableCount = 0;
  for (const raw of rawLines) {
    if (typeof raw !== "object" || raw === null) {
      unreadableCount++;
      continue;
    }
    const line = raw as Record<string, unknown>;
    const productId = extractLineProductId(line);
    const quantity = extractLineQuantity(line);
    if (productId == null || quantity == null) {
      unreadableCount++;
      continue;
    }
    lines.push({ productId, quantity, ...(Array.isArray(line.sources) ? { sources: line.sources } : {}) });
  }
  return { hasLines: true, lines, unreadableCount };
}

export type CartDrift = {
  missing: string[];
  mismatched: { productId: string; expected: number; actual: number }[];
};

// Compares what we PUT with what Mercadona says the cart now holds. Extra lines
// in `actual` are ignored (the user may have added something meanwhile); a line
// we sent that is absent or at a different quantity is drift — typically an
// unavailable product the backend dropped or capped.
export function checkCartDrift(expected: CartLine[], actual: CartLine[]): CartDrift {
  const actualByProduct = new Map(actual.map((l) => [l.productId, l.quantity]));
  const drift: CartDrift = { missing: [], mismatched: [] };
  for (const line of expected) {
    const got = actualByProduct.get(line.productId);
    if (got === undefined) drift.missing.push(line.productId);
    else if (got !== line.quantity) drift.mismatched.push({ productId: line.productId, expected: line.quantity, actual: got });
  }
  return drift;
}

export function hasDrift(drift: CartDrift): boolean {
  return drift.missing.length > 0 || drift.mismatched.length > 0;
}

// Compact one-line summary for the run's errorMessage, e.g.
// "cart_drift missing=123,456 mismatched=789:3->2".
export function describeDrift(drift: CartDrift): string {
  const parts = ["cart_drift"];
  if (drift.missing.length) parts.push(`missing=${drift.missing.join(",")}`);
  if (drift.mismatched.length) {
    parts.push(`mismatched=${drift.mismatched.map((m) => `${m.productId}:${m.expected}->${m.actual}`).join(",")}`);
  }
  return parts.join(" ");
}
