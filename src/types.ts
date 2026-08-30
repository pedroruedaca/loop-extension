// Shared message/response contracts. Two boundaries, each hand-kept in sync
// (no shared package across repos):
//   1. Loop web app  <-->  this extension, via chrome.runtime's
//      externally_connectable (see ../loop/src/lib/extension-bridge.ts).
//   2. tienda.mercadona.es page  <-->  this extension's content scripts, via
//      window.postMessage from the MAIN-world page hook.

// --- (1) Loop page -> background, via externally_connectable ---

export type LoopToExtensionMessage =
  | { type: "loop:ping" }
  | { type: "loop:link-account" }
  | { type: "loop:confirm-prepare"; plannedBasketId: string; lines: ConfirmPrepareLine[] }
  | { type: "loop:sync-catalog" };

export type ConfirmPrepareLine = { listItemId: string; productId: string; quantity: number };

export type ProcessedItem = {
  listItemId: string;
  productId: string;
  quantityRequested: number;
  quantityBefore: number;
  quantityAfter: number;
};

export type ConfirmPrepareResult = {
  status: "ok" | "error" | "partial";
  itemsProcessed: ProcessedItem[];
  requestPayload: unknown;
  responseStatus?: number;
  responseBody?: unknown;
  cartTotalCents?: number;
  driftDetected?: boolean;
  errorMessage?: string;
};

export type SyncCatalogResult = {
  status: "ok" | "error";
  categoriesScanned: number;
  productsUpserted: number;
  errorMessage?: string;
};

// --- (2) page-hook (MAIN world) -> mercadona-content (isolated) ---

export const PAGE_HOOK_SOURCE = "loop-ext-page-hook";

export type PageHookMessage = {
  source: typeof PAGE_HOOK_SOURCE;
  type: "session-captured";
  token: string;
  customerId: string;
  warehouseId: string | null;
};

// --- mercadona-content (isolated) -> background ---

export type ContentToBackgroundMessage = {
  type: "session-captured";
  token: string;
  customerId: string;
  warehouseId: string | null;
};

// --- session state kept in chrome.storage.local ---

export type MercadonaSession = {
  token: string;
  customerId: string;
  warehouseId: string | null;
  capturedAt: number;
};
