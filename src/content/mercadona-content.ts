// Isolated-world content script on tienda.mercadona.es. Only relays what the
// MAIN-world page-hook observes (see page-hook.ts) to the background service
// worker — content scripts can't call chrome.runtime.sendMessage from the
// MAIN world directly, so this is the bridge between the two.
import type { ContentToBackgroundMessage, PageHookMessage } from "../types";

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data as PageHookMessage | undefined;
  if (data?.source !== "loop-ext-page-hook" || data.type !== "session-captured") return;

  const message: ContentToBackgroundMessage = {
    type: "session-captured",
    token: data.token,
    customerId: data.customerId,
    warehouseId: data.warehouseId,
  };
  chrome.runtime.sendMessage(message);
});
