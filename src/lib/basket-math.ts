// Port of Loop's computeCartUpdates (../loop/src/lib/basket-build.ts) — kept
// in sync by hand, no shared package across repos. Pure additive top-up:
// new quantity = whatever's already in the live cart + the due item's
// recurring quantity, so a user's own manual cart additions survive a
// basket-build (see [[project-loop]]).
import type { CartLine } from "./cart-lines";
import type { ConfirmPrepareLine, ProcessedItem } from "../types";

export function computeCartUpdates(
  currentLines: CartLine[],
  dueItems: ConfirmPrepareLine[]
): { lines: CartLine[]; processed: ProcessedItem[] } {
  const currentByProduct = new Map(currentLines.map((l) => [l.productId, l.quantity]));
  const lines: CartLine[] = [];
  const processed: ProcessedItem[] = [];
  for (const item of dueItems) {
    const quantityBefore = currentByProduct.get(item.productId) ?? 0;
    const quantityAfter = quantityBefore + item.quantity;
    lines.push({ productId: item.productId, quantity: quantityAfter });
    processed.push({
      listItemId: item.listItemId,
      productId: item.productId,
      quantityRequested: item.quantity,
      quantityBefore,
      quantityAfter,
    });
  }
  return { lines, processed };
}

// The "fold in memory" half of Loop's documented PUT contract ("always one
// GET, fold in memory, one PUT, never several small writes" — see
// [[project-loop]]): PUT replaces the whole line list, so the payload must
// carry every existing line, not just the due items. computeCartUpdates
// above only computes the due items' new quantities; this merges those back
// onto the full current cart, leaving every other line (including anything
// the user added manually in Mercadona itself) untouched.
export function foldCartLines(currentLines: CartLine[], updatedLines: CartLine[]): CartLine[] {
  const updatesByProduct = new Map(updatedLines.map((l) => [l.productId, l.quantity]));
  const folded = currentLines.map((line) =>
    // Spread keeps the line's existing `sources` so the PUT doesn't erase them.
    updatesByProduct.has(line.productId) ? { ...line, quantity: updatesByProduct.get(line.productId)! } : line
  );
  const existingProducts = new Set(currentLines.map((l) => l.productId));
  for (const update of updatedLines) {
    if (!existingProducts.has(update.productId)) folded.push(update);
  }
  return folded;
}
