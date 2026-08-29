import type { MercadonaSession } from "../types";

async function render() {
  const statusEl = document.getElementById("status")!;
  const { mercadonaSession } = await chrome.storage.local.get("mercadonaSession");
  const session = mercadonaSession as MercadonaSession | undefined;
  if (session) {
    const capturedAt = new Date(session.capturedAt).toLocaleString();
    statusEl.textContent = `Session captured ${capturedAt}${session.warehouseId ? ` (warehouse ${session.warehouseId})` : ""}.`;
  } else {
    statusEl.textContent = "No Mercadona session captured yet.";
  }
}

document.getElementById("open-mercadona")!.addEventListener("click", () => {
  chrome.tabs.create({ url: "https://tienda.mercadona.es" });
});

void render();
