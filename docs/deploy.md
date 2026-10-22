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

## Persistence caveat (Render free, ephemeral disk)

The store (`LICENSE_STORE_PATH=/tmp/xeng/licenses.json`) is wiped on every restart, redeploy or spin-down.
- Every license write is also printed as `ADMIN_AUDIT {"event":"store_put",…}`. Every admin action is printed as `ADMIN_AUDIT {"event":"admin",…}`. These lines stay in Render's logs.
- Keys are **deterministic**: one per Stripe session id, or per admin channel+ref, derived with the signing key. After a wipe:
  - a Stripe buyer re-opening `/paid` gets the same key back;
  - the cashier re-running `node scripts/admin.mjs issue` with the same ref gets the same key back.
- Activated tokens verify offline for 30 days. Renewal after a wipe needs the key re-created as above.
- **Revocations are lost on a wipe.** Re-run `admin.mjs revoke` for refunded keys, which you can find in `ADMIN_AUDIT` lines.
- The device list resets on a wipe, which only affects the 3-device cap.
- Cold start: the first request after 15 min idle takes about 30–60 s, so the extension's activate call can be slow once.

## Redeploy

- Push to GitHub `main`, then Render → **Manual Deploy**. Auto-deploy is off.
- Site: `python3 scripts/build_site.py && npx wrangler pages deploy site --project-name xeng-site --branch main`.
