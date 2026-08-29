// Report-back calls to Loop's own backend. Auth reuses the loop_session
// cookie the browser already carries for whichever Loop origin sent us the
// request (see [[project-loop]]) — `credentials: "include"` plus this
// origin already being in manifest.json's host_permissions is what lets a
// background-worker fetch carry that cookie despite being cross-context.
async function postJson(baseUrl: string, path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { ok: response.ok, status: response.status, body: await response.json().catch(() => null) };
}

export function reportMercadonaStatus(baseUrl: string, linked: boolean) {
  return postJson(baseUrl, "/api/mercadona-status", { linked });
}

export function reportBasketRun(baseUrl: string, report: Record<string, unknown>) {
  return postJson(baseUrl, "/api/basket/runs", report);
}
