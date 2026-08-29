// Runs in the MAIN world (the real page's own JS context) on
// tienda.mercadona.es. Its only job is to notice the Authorization bearer
// token, customer id, and warehouse id that Mercadona's own SPA already
// sends/receives on its normal authenticated calls — never anything typed or
// pasted by the user, never a password. We don't know (and it's not
// documented anywhere) which storage key Mercadona's SPA keeps its token
// under, so instead of guessing a localStorage key, this reads the same
// values directly off outgoing/incoming traffic, which works regardless of
// where the SPA keeps them internally.
//
// Confirmed request shape (from reading mercadona-cli's Go source, see
// [[project-loop]] in Loop's project memory): authenticated calls carry
// `authorization: Bearer <token>` and hit
// `/api/customers/<customerId>/...`; the warehouse id has been observed
// coming back on the `x-customer-wh` response header. Everything here is
// read-only interception — no request is modified, delayed, or blocked.

const API_PREFIX = "/api/";
const CUSTOMER_ID_RE = /\/api\/customers\/([^/]+)\//;

function extractCustomerId(url: string): string | null {
  const match = url.match(CUSTOMER_ID_RE);
  return match ? match[1] : null;
}

function report(token: string, url: string, warehouseId: string | null) {
  const customerId = extractCustomerId(url);
  if (!customerId) return;
  window.postMessage(
    { source: "loop-ext-page-hook", type: "session-captured", token, customerId, warehouseId },
    window.location.origin
  );
}

// --- fetch ---

const originalFetch = window.fetch.bind(window);
window.fetch = async function patchedFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let authHeader: string | null = null;
  if (url.includes(API_PREFIX)) {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    authHeader = headers.get("authorization");
  }
  const response = await originalFetch(input, init);
  if (authHeader?.startsWith("Bearer ")) {
    report(authHeader.slice("Bearer ".length), url, response.headers.get("x-customer-wh"));
  }
  return response;
};

// --- XMLHttpRequest (defensive fallback in case the SPA uses it instead) ---

const originalOpen = XMLHttpRequest.prototype.open;
const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;
const originalSend = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open = function patchedOpen(this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
  (this as unknown as { __loopExtUrl?: string }).__loopExtUrl = typeof url === "string" ? url : url.href;
  // @ts-expect-error - forwarding the original signature's variadic tail as-is
  return originalOpen.call(this, method, url, ...rest);
};

XMLHttpRequest.prototype.setRequestHeader = function patchedSetHeader(this: XMLHttpRequest, name: string, value: string) {
  if (name.toLowerCase() === "authorization") {
    (this as unknown as { __loopExtAuth?: string }).__loopExtAuth = value;
  }
  return originalSetHeader.call(this, name, value);
};

XMLHttpRequest.prototype.send = function patchedSend(this: XMLHttpRequest, ...args: unknown[]) {
  const self = this as unknown as { __loopExtUrl?: string; __loopExtAuth?: string };
  if (self.__loopExtAuth?.startsWith("Bearer ") && self.__loopExtUrl?.includes(API_PREFIX)) {
    const token = self.__loopExtAuth.slice("Bearer ".length);
    const url = self.__loopExtUrl;
    this.addEventListener("load", () => {
      report(token, url, this.getResponseHeader("x-customer-wh"));
    });
  }
  // @ts-expect-error - forwarding send's variadic signature as-is
  return originalSend.apply(this, args);
};
