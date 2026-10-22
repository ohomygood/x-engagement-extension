# X 互动名单助手 / X Engagement List (Chrome MV3)

> Public source, all rights reserved (see `LICENSE`). Not yet on the Chrome Web Store. Privacy policy: https://xeng-site.pages.dev/privacy · license server on Render (`render.yaml`, `docs/deploy.md`).

Local-only Chrome extension: commenter leaderboard (7/30/90 days), pending-reply list, not-following-back and
unfollower detection from user-started snapshots of the user's own lists, CSV export and multi-account (Pro).
**No automatic follow/unfollow/like/reply/DM. No network requests except the Pro license check.**

> Status: MVP built and tested locally (unit + real-Chrome E2E on local fixtures). Not published. Stripe Payment
> Link, Cloudflare Worker deploy, domain and Chrome Web Store developer account are PENDING approval (placeholders in
> `src/config.ts` and `worker/wrangler.toml`).

## Layout
| Path | What |
|---|---|
| `src/selectors.ts` | **All X DOM selectors in one file**, each with ordered fallbacks + text fallbacks (EN / 简 / 繁 / 日). Fix X markup changes here. |
| `src/parse.ts` | Page detection, signed-in user, tweet + "Replying to" parsing (status-page focal-post inference), user cells |
| `src/analytics.ts` | Leaderboard, pending replies, not-following-back, unfollower diff (complete snapshots only), plan limits, CSV (BOM + formula-injection guard) |
| `src/db.ts` | IndexedDB (`tweets` keyed [account,id], `snapshots`, `meta`); the service worker is the only writer |
| `src/content.ts` | MutationObserver capture (800 ms throttle), SPA nav, selector-health pings, Shadow-DOM snapshot panel on own Following/Followers only, human-pace scroll (0.85 screen / 1.5–2.5 s, Stop = partial snapshot) |
| `src/background.ts` | Validates messages (sender id + schema), stores, multi-account gate (Pro), opens dashboard |
| `src/dashboard.ts` | Tabs, 100-row pagination, CSV (Pro), license activation + silent renewal, account switch, wipe, selector diagnostics |
| `src/license.ts`, `src/plan.ts` | ECDSA P-256 signed tokens verified offline (30-day expiry, renew when <7 days left, max once/day) |
| `worker/` | Cloudflare Worker: `/paid?session_id=` (alias `/claim`) retrieves the Checkout Session with a read-only restricted key, verifies complete/paid/payment link/499 usd, issues one key per session (derived from the session id, so redirect and webhook can't mint two); optional signed webhook re-checks via the API too; `/activate` (max 3 devices, CORS to extension origin); refund → revoke; owner `/admin/issue` + `/admin/revoke` for comps and support (`docs/manual_unlock.md`). Stores no e-mail. |
| `store/` | zh/en listing, privacy policy, review notes (single purpose + permission justification), 1280×800 screenshots (en/zh), 440×280 tile |
| `tests/` | vitest unit tests (jsdom + fake-indexeddb), worker tests, `tests/fixtures/xdom.mjs` (X markup reproductions), `tests/e2e/run.mjs` (real Chrome via puppeteer-core) |

Build tool: **esbuild** (IIFE bundles) instead of the planned Vite — MV3 content scripts cannot be ES modules and
esbuild needs no plugin for that. Output is identical in kind (plain JS + static files).

## Commands
```bash
npm install
npm run typecheck        # extension + worker
npm test                 # 30 unit/worker tests
npm run e2e              # builds dist-e2e (adds localhost match) and runs 14 checks in real Chrome; writes store/screenshots
npm run build            # dist/  (load unpacked in chrome://extensions)
node scripts/package.mjs # release zip; refuses while placeholders remain (--allow-placeholders for a review zip)
node scripts/keygen.mjs  # license key pair: public JWK -> src/config.ts, private -> keys/ (git-ignored) -> wrangler secret
```

## Go-live checklist (needs approval via the owner)
1. Cloudflare account (free): `wrangler kv namespace create LICENSES`, set id in `worker/wrangler.toml`, `wrangler secret put STRIPE_WEBHOOK_SECRET` and `LICENSE_PRIVATE_JWK`, `wrangler deploy`.
2. Stripe Payment Link (live, wired in): https://buy.stripe.com/8x2bJ2gbY8bLfiC2hT0Ny03, $4.99 one-off. The upgrade button appends `?client_reference_id=<install id>`. Dashboard steps (redirect to `<LICENSE_URL>/paid?session_id={CHECKOUT_SESSION_ID}`, read-only restricted key, optional webhook for `checkout.session.completed` + `charge.refunded`) are in `docs/stripe_setup.md`.
3. Put Worker URL, Payment Link and public JWK in `src/config.ts`; host `store/privacy-policy.md` at `PRIVACY_URL`.
4. Chrome Web Store developer account (one-time registration fee — needs spending approval), upload `release/*.zip`, paste `store/` texts.
5. After CWS assigns the extension ID, set `ALLOWED_ORIGINS` in `wrangler.toml`.

## Refund policy

**Full refund on request within 7 days of purchase, once per customer.** Contact: go_with_prob@mail.grokbot.com.
Shown on https://xeng-site.pages.dev/terms (bilingual, linked from the site footer) and on every license-server `/paid` page
(`REFUND_POLICY` in `worker/src/index.ts`; keep in sync with `TERMS` in `scripts/build_site.py`).

Handling a request (owner):
1. Check the purchase is within 7 days (Stripe Dashboard → Payments) and that this customer hasn't had a refund before
   (we store no e-mail; check the Stripe customer e-mail / card against earlier refunds in the Dashboard).
2. Refund the full amount in the Stripe Dashboard.
3. The key is revoked automatically: the next `/paid` visit re-checks the charge immediately, and activation/renewal
   re-checks at most every 24 h (Charges: Read); the optional `charge.refunded` webhook revokes at once.
   To be sure, also run `node scripts/admin.mjs revoke … --reason refunded` (docs/manual_unlock.md) and add the session to `REVOKED_REFS`.
4. Caveat: an already-activated install keeps Pro offline until its signed token expires (≤ 30 days); it can't renew.

## Maintenance: when X changes its markup
Settings → Diagnostics shows which selector matched on the last page (and 0-count ones in red). Update the
fallback list in `src/selectors.ts`, add the new markup to `tests/fixtures/xdom.mjs`, run `npm test && npm run e2e`.
