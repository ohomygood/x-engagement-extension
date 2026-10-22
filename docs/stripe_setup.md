# Stripe setup for X 互动名单助手 Pro (for the owner)

Stripe is the only payment method. Comps and support keys can be issued by hand: see `docs/manual_unlock.md`.

Already wired in the code: the live Pro Payment Link `https://buy.stripe.com/8x2bJ2gbY8bLfiC2hT0Ny03` ($4.99 one-off).
- The extension's **Buy Pro** buttons open it as `…?client_reference_id=<install id>`. The install id is a random ID made by the extension.
- The store listing links to the plain URL. Those purchases still get a key; they just aren't tied to an install.

What you need to do in the Stripe Dashboard: 3 required steps and 1 optional step, about 10 minutes.
Replace `<LICENSE_URL>` with the license Worker's URL once it is deployed, e.g. `https://license.<domain>` or `https://xeng-license.<you>.workers.dev`. No trailing slash.

> Do the steps in **live mode**. To test first in a **sandbox or test mode**, repeat them there too. Test-mode values are separate.

## 1. After-payment redirect on the Payment Link

1. Dashboard → **Payment Links** → click the $4.99 link (`buy.stripe.com/8x2bJ2gbY8bLfiC2hT0Ny03`) → **Edit**.
2. **After payment** tab (older layouts: **Confirmation page**) → **Don't show confirmation page → Redirect customers to your website**.
3. URL, exactly:
   ```
   <LICENSE_URL>/paid?session_id={CHECKOUT_SESSION_ID}
   ```
   Keep `{CHECKOUT_SESSION_ID}` literally.
4. **Save / Update link**. The buy.stripe.com URL doesn't change.
5. Copy the link's **ID**. It starts with `plink_` and is in the address bar (`…/payment-links/plink_…`) or in the link details.
   It goes in the Worker var `PAYMENT_LINK_ID` (`worker/wrangler.toml`).

Keep **promotion codes** and **quantity adjustment** off. The Worker only accepts exactly 499 USD cents (`EXPECTED_AMOUNT` / `EXPECTED_CURRENCY`).

## 2. Restricted API key, read-only

1. Dashboard → **Developers → API keys → Create restricted key**. If asked, pick "Building your own integration".
2. Name: `xeng-license-readonly`.
3. Permissions: **Checkout Sessions → Read**. Leave **everything else at None**.
   - The Worker makes one call, `GET /v1/checkout/sessions/{id}`. Every field it checks is on that object, including `payment_intent`, which is kept for refund revocation.
   - No other permission is needed. Refunds are handled by the optional webhook in step 3, not by API calls.
   - A key that also has **read-only** Charges or Balance transactions works too, because only `GET /v1/checkout/sessions/{id}` is called. Anything that isn't `rk_` (e.g. full `sk_` secret keys) is refused.
4. Create the key and copy the `rk_live_…` value. It is shown only once.
5. Store it as a Worker secret, not in chat or email:
   ```
   cd worker && npx wrangler secret put STRIPE_RESTRICTED_KEY
   ```
   The Worker refuses full `sk_…` keys.
   With no restricted key or no `PAYMENT_LINK_ID`, **no license key is ever issued**: the page says verification isn't switched on yet.

## 3. (Optional, recommended) Webhook backup + refund revocation

1. Dashboard → **Developers → Webhooks** (or **Workbench → Webhooks / Event destinations**) → **Add destination / endpoint**.
2. Events:
   - `checkout.session.completed` and `checkout.session.async_payment_succeeded`, the backup if the buyer closes the tab before the redirect;
   - `charge.refunded`, which revokes the key after a refund. **Without this webhook, refunded keys keep working** until you revoke them by hand.
3. Endpoint URL: `<LICENSE_URL>/stripe/webhook`.
4. Create it, then **Reveal** the **Signing secret** (`whsec_…`) and store it:
   `cd worker && npx wrangler secret put STRIPE_WEBHOOK_SECRET`.
   Tell us when it's set. We don't need the value.

Even a correctly signed checkout event isn't trusted on its own. The Worker re-fetches the session with the restricted key.
The license key is derived from the session id, and the session is recorded in KV (`session:<id>`).
So the redirect and the webhook produce the same single key, whichever arrives first.

## 4. Check it

1. Open the extension → Settings → **Buy Pro**. The URL should end with `?client_reference_id=<uuid>`.
2. Pay, or use a test-mode link.
3. You land on `<LICENSE_URL>/paid?session_id=…`, which shows the `XENG-XXXX-XXXX-XXXX` key.
4. Paste the key into Settings → **Activate**.
5. Reloading the page always shows the same key, also after a server restart. After a full refund it no longer does.

## What `/paid` verifies

| Check | Value |
|---|---|
| `session_id` format | `cs_(live\|test)_…`, otherwise no API call |
| Retrieved with | `STRIPE_RESTRICTED_KEY` (`rk_…`) |
| `status` / `mode` / `payment_status` | `complete` / `payment` / `paid` |
| `payment_link` | `== PAYMENT_LINK_ID` |
| amount + currency | `499` `usd` in the integration currency (see Adaptive Pricing) |
| `client_reference_id` | optional; if present, must look like an install id |
| single use | one deterministic key per session (`HMAC(signing key, session id)`); re-shown on every visit; a replay yields the same key |
| refund | `GET /v1/charges?payment_intent=…` (needs **Charges: Read**; optional) — full refund → key revoked |

## Restricted key permissions

- **Checkout Sessions: Read** (required): `/paid`, the webhook re-check, and rebuilding keys after a store wipe (session list filtered by `payment_link`).
- **Charges: Read** (recommended): refund detection that survives store wipes. Without it, `/health` still works and keys stay valid. Refunded keys then need `REVOKED_REFS` (docs/deploy.md).

## Adaptive Pricing

- If Adaptive Pricing is on for the account, which is an account-wide Payments setting, CNY buyers see a converted local price, not a fixed CNY amount.
  The listing and button say "$4.99 USD; Stripe checkout may show your local currency" (Adaptive Pricing is always on for Payment Links; buyers can also pay in USD).
- Sessions on API ≥ 2025-03-31 keep `amount_total`/`currency` at `499`/`usd`, with the local amount in `presentment_details`.
  On older API versions the local values sit at the top level, with USD under `currency_conversion`.
  The Worker accepts both.
  Sources:
  - <https://docs.stripe.com/changelog/basil/2025-03-31/add_presentment_details>
  - <https://docs.stripe.com/changelog/clover/2025-09-30/remove-checkout-session-currency-conversion-field>
