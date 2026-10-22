# Live deployment — 2026-10-22 (UTC+8)

| Part | URL | Host / plan |
|---|---|---|
| License server | https://xeng-license.onrender.com (health: `/health`) | Render free web service `xeng-license` (Node 20, Singapore), `srv-dbcpdifb9u1s73cf4rng`. Runs `worker/src/index.ts` via `server/node-server.mjs`. |
| Public site + privacy policy (for the Chrome Web Store) | https://xeng-site.pages.dev · https://xeng-site.pages.dev/privacy | Cloudflare Pages project `xeng-site` (`python3 scripts/build_site.py` → `site/`) |
| Source | https://github.com/ohomygood/x-engagement-extension | public, all rights reserved |
| Chrome Web Store | **not published** | |

**Why Render and not Cloudflare Workers:** the Cloudflare token only allows Pages edits, so the Worker handler runs on Node (Render) with a JSON-file store in place of Workers KV.

State: **test-safe**.
- No `STRIPE_RESTRICTED_KEY` or `PAYMENT_LINK_ID` is set, so `/paid` refuses every session and no key is issued from Stripe.
- No webhook secret is set, so `/stripe/webhook` returns 503.
- Admin routes are enabled. The token is a Render secret, also stored on the ops box at `/workspace/infra/secrets/admin_tokens.env` (not in git).

## Stripe, when ready

- Payment Link `https://buy.stripe.com/8x2bJ2gbY8bLfiC2hT0Ny03` → After payment → redirect to:
  `https://xeng-license.onrender.com/paid?session_id={CHECKOUT_SESSION_ID}`
- Webhook (optional, but needed for automatic refund revocation): `https://xeng-license.onrender.com/stripe/webhook`.
  Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`.
- Restricted key: **Checkout Sessions: Read** at minimum. Charges and Balance transactions read access are optional.
- Render env vars to set (names only): `STRIPE_RESTRICTED_KEY`, `PAYMENT_LINK_ID`, and optionally `STRIPE_WEBHOOK_SECRET`. Then Manual Deploy.
- **Status 2026-10-22 13:25 (UTC+8): configured.**
  - `STRIPE_RESTRICTED_KEY` (`rk_live`, read-only) and `PAYMENT_LINK_ID=plink_1UTDRVJvue1A936QhWDxMngL` are set, and `/health` shows `payments_configured: true`.
  - The link (verified via the API) is active, 499 USD × 1, promo codes off, and redirects to `/paid`.
  - The key has Read on Checkout Sessions and Charges, so the refund re-check is active.
  - `REVOKED_REFS=comp:deploy-smoke-recovery-20261022` revokes the deploy smoke-test key.

## Persistence (Render free, ephemeral disk)

The store (`LICENSE_STORE_PATH=/tmp/xeng/licenses.json`) is wiped on every restart, redeploy or spin-down.
No key needs it to stay valid:
- **Stripe keys** are `HMAC(signing key, checkout session id)`.
  - `/paid?session_id=…` always re-derives and re-shows the key. There is no 7-day claim window any more.
  - `/activate` with an unknown 3-group key lists the Payment Link's completed sessions in Stripe (Checkout Sessions: Read), re-derives their keys and rebuilds the matching record.
  - That scan runs at most once per 30 s, then only fetches newer sessions, with up to 20 pages of 100.
- **Refunds** are re-checked in Stripe when a record is (re)built, and at most daily on activation: `GET /v1/charges?payment_intent=…`, which needs **Charges: Read**.
  - A fully refunded charge revokes the key. A partial refund keeps it.
  - Without Charges: Read the check records `unavailable` and the key stays valid. Then rely on the `charge.refunded` webhook (lost on a wipe) and on `REVOKED_REFS`.
- **Admin (WeChat) keys** are 4-group and self-verifying: `XENG-<id 8>-<mac 8>`. The id is HMAC(channel:ref), and the 40-bit MAC is keyed by the server.
  - A wiped store still accepts them, and re-issuing the same ref returns the same key.
- **Durable revocations:** env `REVOKED_REFS`, a comma/space list of any of: `XENG-…` keys, `cs_…` session ids, `pi_…` payment intents, `<channel>:<ref>`.
  - `/admin/revoke` answers with `add_to_REVOKED_REFS`.
  - `node scripts/admin.mjs revoked-refs --from <exported log>` rebuilds the whole value from the `ADMIN_AUDIT` lines.
  - Set it on Render, then redeploy. KV revocations alone are lost on a wipe.
- **Not recoverable:** the per-key device lists (3-device cap) restart from zero after a wipe, and so do admin lockout counters and `/admin/log` history (the `ADMIN_AUDIT` lines in Render logs remain).
- Every license write is also printed as `ADMIN_AUDIT {"event":"store_put",…}`, and every admin action as `ADMIN_AUDIT {"event":"admin",…}`.
- Cold start: the first request after 15 min idle takes about 30–60 s, so the extension's activate call can be slow once.

## Redeploy

- Push to GitHub `main`, then Render → **Manual Deploy**. Auto-deploy is off.
- Site: `python3 scripts/build_site.py && npx wrangler pages deploy site --project-name xeng-site --branch main`.
