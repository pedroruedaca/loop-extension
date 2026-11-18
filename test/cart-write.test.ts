// Run with: npm test  (Node's built-in runner; Node >= 23 strips TS types natively)
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCartDrift, describeDrift, hasDrift, parseCartLines } from "../src/lib/cart-lines.ts";
import { computeCartUpdates, foldCartLines } from "../src/lib/basket-math.ts";

test("parseCartLines reads nested and flat line shapes and keeps sources", () => {
  const parsed = parseCartLines({
    lines: [
      { product: { id: "123" }, quantity: 2, sources: [{ kind: "recipe" }] },
      { product_id: "456", quantity: 1 },
      { product: { id: 789 }, quantity: "3" },
    ],
  });
  assert.equal(parsed.hasLines, true);
  assert.equal(parsed.unreadableCount, 0);
  assert.deepEqual(parsed.lines, [
    { productId: "123", quantity: 2, sources: [{ kind: "recipe" }] },
    { productId: "456", quantity: 1 },
    { productId: "789", quantity: 3 },
  ]);
});

test("parseCartLines counts lines it cannot read instead of dropping them silently", () => {
  const parsed = parseCartLines({
    lines: [{ product: { id: "123" }, quantity: 2 }, { item: { sku: "x" }, qty: 1 }, null, { product_id: "9" }],
  });
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.unreadableCount, 3);
});

test("parseCartLines distinguishes a missing lines array from an empty cart", () => {
  assert.deepEqual(parseCartLines({ lines: [] }), { hasLines: true, lines: [], unreadableCount: 0 });
  assert.equal(parseCartLines({ items: [] }).hasLines, false);
  assert.equal(parseCartLines(null).hasLines, false);
  assert.equal(parseCartLines("<html>").hasLines, false);
});

test("foldCartLines keeps existing sources on updated lines and untouched lines", () => {
  const current = [
    { productId: "1", quantity: 1, sources: ["a"] },
    { productId: "2", quantity: 4, sources: ["b"] },
  ];
  const { lines: updates } = computeCartUpdates(current, [
    { listItemId: "li1", productId: "1", quantity: 2 },
    { listItemId: "li3", productId: "3", quantity: 1 },
  ]);
  assert.deepEqual(foldCartLines(current, updates), [
    { productId: "1", quantity: 3, sources: ["a"] },
    { productId: "2", quantity: 4, sources: ["b"] },
    { productId: "3", quantity: 1 },
  ]);
});

test("checkCartDrift flags missing and changed lines, ignores extras", () => {
  const sent = [
    { productId: "1", quantity: 3 },
    { productId: "2", quantity: 4 },
    { productId: "3", quantity: 1 },
  ];
  const got = [
    { productId: "1", quantity: 3 },
    { productId: "2", quantity: 2 },
    { productId: "99", quantity: 1 },
  ];
  const drift = checkCartDrift(sent, got);
  assert.deepEqual(drift, { missing: ["3"], mismatched: [{ productId: "2", expected: 4, actual: 2 }] });
  assert.equal(hasDrift(drift), true);
  assert.equal(describeDrift(drift), "cart_drift missing=3 mismatched=2:4->2");
});

test("checkCartDrift reports nothing when the cart matches", () => {
  const lines = [{ productId: "1", quantity: 3 }];
  assert.equal(hasDrift(checkCartDrift(lines, [...lines, { productId: "2", quantity: 1 }])), false);
});
