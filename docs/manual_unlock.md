# 手动发码 / Manual license keys (comps and support) for X 互动名单助手 Pro

Stripe is the only payment method. WeChat Pay was removed from the extension, the store listing and the site on
2026-10-22, and no QR or ¥ price is shown anywhere. This path is for the owner only: free comps (reviewers,
partners) and support cases. It never takes money itself. Every action is logged.

## 1. One-time setup: ADMIN_TOKEN

```bash
openssl rand -hex 32                                   # 64 hex chars; at least 32 are required
cd worker && npx wrangler secret put ADMIN_TOKEN       # paste it at the prompt
```

- Stored **only** as a Cloudflare Worker secret, with a copy in your password manager.
  **Never paste it in chat, e-mail or the repo.**
- Unset or shorter than 32 chars → every `/admin/*` route returns 404.
- Rotate: generate a new token and run `wrangler secret put ADMIN_TOKEN` again.

## 2. Issue a key

```bash
read -rs ADMIN_TOKEN && export ADMIN_TOKEN   # paste; nothing is echoed and it isn't saved to shell history
node scripts/admin.mjs issue --url <LICENSE_URL> --by owner --reason "comp for reviewer" \
  --channel comp --ref comp-2026-001
# → {"result":"issued","key":"XENG-…"}   send the key to the buyer; they paste it in Settings → Activate
```

or with curl:

```bash
curl -sS -X POST "<LICENSE_URL>/admin/issue" -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"by":"owner","reason":"comp for reviewer","channel":"comp","ref":"comp-2026-001"}'
```

- `ref` (a unique note, e.g. `comp-2026-001`) is **required**.
- **Idempotent per channel + ref**: running it again for the same ref returns `{"result":"existing","key":<the same key>}` and never mints a second key.
  The key is derived from channel + ref, so two concurrent calls also give one key.
- `channel` defaults to `comp`; `install` is optional.

## 3. Revoke (refund)

```bash
node scripts/admin.mjs revoke --url <LICENSE_URL> --by owner --reason "refunded" --key XENG-XXXX-XXXX-XXXX --ref <txn>
```

- Returns `revoked`, `already_revoked` (a no-op that is still logged), or 404 `not_found`.
- Activated devices lose Pro when their token renews, within 30 days. New activations fail at once.
- Re-issuing for a refunded ref returns the same, revoked key. Use a new ref for a genuine new payment.
- Stripe purchases are revoked automatically: by the refund re-check (Charges: Read) or the `charge.refunded` webhook (docs/stripe_setup.md), or by hand with this command.
- **Make it permanent.** The store is wiped on Render restarts. Add the returned `add_to_REVOKED_REFS` value (e.g. `comp:<ref>`) to the
  `REVOKED_REFS` env var on Render and redeploy. `node scripts/admin.mjs revoked-refs --from <exported log>` prints the full list.
- Keys issued here have 4 groups (`XENG-XXXX-XXXX-XXXX-XXXX`) and are self-verifying, so they keep working after a wipe.

## 4. Log and security

- `node scripts/admin.mjs log --url <LICENSE_URL> --limit 50` shows the latest entries.
  Each is an append-only KV entry `adminlog:<iso ts>:<rand>` (never overwritten) with
  `ts, action, by, reason, channel, amount, currency, ref, install, key, source (endpoint|cli), result`.
  Each action, and each failed auth attempt (IP only), is also printed as one `ADMIN_AUDIT {json}` line via console.log.
  Those lines persist in Cloudflare Workers logs: enable Workers Logs / Logpush, or watch them live with `npx wrangler tail`.
  `ADMIN_TOKEN`, the Stripe key and the webhook secret are never included; they are scrubbed even if pasted into a field.
- Optional export, **not scheduled**: `node scripts/admin.mjs log --url <LICENSE_URL> --limit 1000 > admin_log_$(date +%Y%m%d).json`.
- Token check: SHA-256 of both values, then a constant-time compare.
- Lockout via KV counters (15 min): 5 failures per `CF-Connecting-IP`, or 20 failures in total, return 429, even for the right token.
  KV is eventually consistent, so treat these as approximate limits; the token's length is the real protection.

## 5. No QR, ever

No payment QR is shipped. `scripts/build.mjs` copies only an allowlist of static files and then runs `scripts/check_release.mjs`.
`scripts/package.mjs` checks the zip too, and the site build checks `site/`.
Each check fails on: any image other than the icons and the site screenshots; QR/WeChat-like file names; a file identical to the owner's real QR; or WeChat/¥ payment copy.
