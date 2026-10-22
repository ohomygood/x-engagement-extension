# 手动发码 / Manual license keys (WeChat Pay) for X 互动名单助手 Pro

For the cashier. In the Chinese UI (Settings), buyers see "或微信支付 ¥29": the QR, their **安装 ID / install id**, and the contact.
The contact is **go_with_prob@mail.grokbot.com** (`src/config.ts` → `CONFIG.WECHAT.CONTACT`). Never publish a personal WeChat ID.
Buyer copy (zh): "付款后把付款截图 + install id 发到 go_with_prob@mail.grokbot.com，24 小时内开通". **Issue the key within 24 h.**
Buyers pay the QR, then send the install id plus a screenshot or transaction number.
**No WeChat API is ever called**: the cashier checks the payment in WeChat by hand, then issues a key.

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
node scripts/admin.mjs issue --url <LICENSE_URL> --by owner --reason "WeChat Pay ¥29 confirmed" \
  --ref 4200001234202610220001 --amount 29 --install <install id from the buyer>
# → {"result":"issued","key":"XENG-…"}   send the key to the buyer; they paste it in Settings → Activate
```

or with curl:

```bash
curl -sS -X POST "<LICENSE_URL>/admin/issue" -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"by":"owner","reason":"WeChat Pay confirmed","channel":"wechat","amount":29,"currency":"CNY",
       "ref":"4200001234202610220001","install":"<install id>"}'
```

- `ref` (the WeChat transaction id, or the note if there is no id) is **required**.
- **Idempotent per channel + ref**: running it again for the same ref returns `{"result":"existing","key":<the same key>}` and never mints a second key.
  The key is derived from channel + ref, so two concurrent calls also give one key.
- `channel` defaults to `wechat`; `currency` defaults to CNY for wechat/alipay; `install` is optional.

## 3. Revoke (refund)

```bash
node scripts/admin.mjs revoke --url <LICENSE_URL> --by owner --reason "refunded" --key XENG-XXXX-XXXX-XXXX --ref <txn>
```

- Returns `revoked`, `already_revoked` (a no-op that is still logged), or 404 `not_found`.
- Activated devices lose Pro when their token renews, within 30 days. New activations fail at once.
- Re-issuing for a refunded ref returns the same, revoked key. Use a new ref for a genuine new payment.
- Stripe purchases are revoked automatically by the `charge.refunded` webhook (docs/stripe_setup.md), or by hand with this command.

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

## 5. QR image

`static/wechat_pay_qr.jpg` is a **local, gitignored copy**. Create it with `scripts/install_wechat_qr.sh`, which copies `/workspace/payment/wechat_pay_qr.jpg`.
It is referenced by `CONFIG.WECHAT.QR`. `npm run build` packages it, so **the Chrome Web Store zip contains the QR**, which is intended because buyers must see it.
It is not in git. If it's missing, the image hides and the text instructions remain.
