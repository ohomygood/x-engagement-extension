/** Public configuration. Nothing here is secret. */
export const CONFIG = {
  // License server (worker/src/index.ts running on Render via server/node-server.mjs).
  LICENSE_API: 'https://xeng-license.onrender.com',
  // Live Stripe Payment Link for Pro ($4.99 one-off). Its after-payment redirect must be
  // LICENSE_API + '/paid?session_id={CHECKOUT_SESSION_ID}' (docs/stripe_setup.md). Open it via upgradeUrl().
  PAYMENT_LINK: 'https://buy.stripe.com/8x2bJ2gbY8bLfiC2hT0Ny03',
  // ECDSA P-256 public key (JWK) matching the Worker's LICENSE_PRIVATE_JWK secret. Generate with `node scripts/keygen.mjs`.
  LICENSE_PUBLIC_JWK: { kty: 'EC', crv: 'P-256', x: 'ppmEi6hpdId5IJgYv3pIghDoHyteezJ15s6bssu5hko', y: 'bSnuoDnDL2bB_8uRaHZbz2gQe5fa7S34DaCEkH-gihQ' } as JsonWebKey,
  PRIVACY_URL: 'https://xeng.aiseenlab.com/privacy',
};

/** Stripe allows alphanumerics, '-' and '_' (max 200) in client_reference_id. */
const REF_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Upgrade URL with ?client_reference_id=<install id> so the license server can tie the purchase to this install. */
export function upgradeUrl(installId?: string | null): string {
  return installId && REF_RE.test(installId)
    ? `${CONFIG.PAYMENT_LINK}?client_reference_id=${encodeURIComponent(installId)}`
    : CONFIG.PAYMENT_LINK;
}
