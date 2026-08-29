# loop-extension

Chrome (Manifest V3) extension for [Loop](../loop). Acts directly in the
user's own live `tienda.mercadona.es` browser session — no credential, token,
or cookie of any kind ever passes through Loop's backend or any other server
(see `[[project-loop]]` in Loop's project memory for the full history of why:
the original design used a Go adapter with spoofed TLS fingerprinting to
replay a stored session server-side; that was retired 2026-08-28 in favor of
this extension acting in a real browser, which needs no spoofing because it
*is* a real browser).

## What it does (v1 scope)

Two explicit-click jobs only — nothing on a timer, nothing on page load,
nothing autonomous. This mirrors a hard constraint from Loop's project
memory: Loop must never touch a user's Mercadona cart without the user
directly triggering that specific action.

1. **Link** — user clicks "Link via extension" on Loop's dashboard. The
   extension opens/focuses a `tienda.mercadona.es` tab and waits (up to 15s)
   for `content/page-hook.ts` to observe an authenticated API call the SPA
   itself makes, capturing the bearer token, customer id, and (if present)
   warehouse id off real traffic — never a guessed `localStorage` key, never
   anything typed into Loop. Reports `linked: true/false` straight to
   `POST /api/mercadona-status` on Loop's backend.
2. **Confirm & Prepare** — user clicks the button on Loop's `/basket` page.
   Loop sends the due line items to the extension; the extension does one
   `GET` of the live cart, folds the due items' additive quantities into the
   full line list (`lib/basket-math.ts`, a hand-kept port of Loop's
   `computeCartUpdates`), and does one `PUT` back to Mercadona — matching the
   documented "one GET, fold in memory, one PUT" contract. Reports the
   outcome straight to `POST /api/basket/runs`.

Address and delivery-slot selection are **out of scope** — same blocker as
before (`C:\Users\Pedro\.claude\plans\replicated-puzzling-sutton.md`):
nobody has captured Mercadona's real checkout/slot API shapes yet. Payment
submission is a hard non-goal, not just an MVP cut.

## Architecture

- **Loop page → extension**: `chrome.runtime.sendMessage(extensionId, ...)`
  via `externally_connectable` in `manifest.json` — no content script needed
  on Loop's own pages. See `../loop/src/lib/extension-bridge.ts` for the
  message shapes; they're hand-kept in sync with `src/types.ts` here, no
  shared package across the two repos.
- **Extension → Mercadona**: `src/lib/mercadona-api.ts`, direct `fetch` calls
  from the background service worker using the captured bearer token —
  `host_permissions` on `tienda.mercadona.es` is what lets this bypass CORS.
- **Extension → Loop backend**: `src/lib/loop-api.ts`, `fetch` with
  `credentials: "include"` so the request carries the `loop_session` cookie
  already sitting in the browser for whichever Loop origin sent the
  triggering message (`sender.origin` in `background.ts`'s
  `onMessageExternal` handler — this is also how the background worker knows
  whether to report back to `localhost:3000` or a deployed origin, without
  hardcoding it).
- **Mercadona page → extension**: `src/content/page-hook.ts` runs in the
  page's own MAIN world (not the isolated content-script world) so it can
  patch `window.fetch`/`XMLHttpRequest` and observe the SPA's own outgoing
  `Authorization` header and the `x-customer-wh` response header, without
  modifying, delaying, or blocking anything. It `postMessage`s what it sees
  to `src/content/mercadona-content.ts` (isolated world), which relays to the
  background worker via `chrome.runtime.sendMessage`.

## Setup (dev)

```
npm install
npm run build        # or: npm run watch
```

Load `dist/` as an unpacked extension: `chrome://extensions` → enable
Developer Mode → "Load unpacked" → select `loop-extension/dist`.

The extension's id is **pinned** via `manifest.json`'s `key` field (derived
from `dev-key.pem`, gitignored — losing that file just means the dev id
changes on a fresh keypair, nothing security-sensitive is lost). Current dev
id: see `dev-extension-id.txt`. Set that value as
`NEXT_PUBLIC_LOOP_EXTENSION_ID` in `../loop/.env.local` so Loop's frontend
knows which extension to message.

## Before shipping past localhost

`manifest.json`'s `host_permissions` and `externally_connectable.matches`
currently only allow `http://localhost:3000/*`. Before pointing this at a
real deployed Loop origin, add that **exact** origin (never a wildcard like
`*.vercel.app`) to both lists — `externally_connectable` is what lets a page
trigger `loop:link-account`/`loop:confirm-prepare`, i.e. actual writes to the
user's Mercadona cart, so a wildcard there would let any site on that domain
suffix do the same.

Once published to the Chrome Web Store, the store assigns its own id
(ignoring the `key` field) — swap `NEXT_PUBLIC_LOOP_EXTENSION_ID` to that
real id at that point.

## Open items / not independently verified this session

- **Cart response field names**: `lib/mercadona-api.ts`'s parsing of a `GET`
  cart response (`line.product.id` vs `line.product_id`, `summary.total`) is
  transcribed from Loop's project memory (itself read from `mercadona-cli`'s
  Go source, not from a live capture this session) and defensively
  multi-path, but not exercised against a real account. First live test
  should watch for `driftDetected`-worthy surprises here.
- **Warehouse id discovery**: assumes some authenticated call the SPA makes
  organically still returns `x-customer-wh` — that behavior was originally
  observed on the now-retired postal-code endpoint, not re-confirmed on
  whatever calls the SPA fires by default when a session is already logged
  in. If it never shows up, cart calls need to be tried without `wh` first
  (unconfirmed whether that's accepted) before adding an explicit request
  for it.
- **No icons** — `manifest.json` omits `icons`; Chrome will show a default
  puzzle-piece action icon until one's added. Cosmetic only.
- **Opportunistic product-cache sync** (search results feeding
  `POST /api/product-cache` in Loop while a user just browses Mercadona
  normally) is a separate, not-yet-built follow-up — this build only does
  the two explicit-click jobs above.
- **End-to-end**: nothing here has been loaded into a real Chrome profile
  against a real logged-in Mercadona account yet. `npm run build` and
  `tsc --noEmit` are clean, but that only proves the code compiles and
  bundles — the actual link → confirm-prepare flow needs a live run with
  Loop's dev server (`npm run dev` in `../loop`) and a real Mercadona
  session before this is trustworthy.
