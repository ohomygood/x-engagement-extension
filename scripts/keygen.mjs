// Generate the ECDSA P-256 key pair for license tokens. Prints the PUBLIC JWK (paste into src/config.ts)
// and writes the PRIVATE JWK to keys/license-private.jwk.json (git-ignored) for `wrangler secret put`.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
const out = 'keys/license-private.jwk.json';
if (existsSync(out) && !process.argv.includes('--force')) { console.error(`${out} exists; use --force to replace (old tokens stop verifying)`); process.exit(1); }
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pub = await crypto.subtle.exportKey('jwk', kp.publicKey);
const priv = await crypto.subtle.exportKey('jwk', kp.privateKey);
mkdirSync('keys', { recursive: true, mode: 0o700 });
writeFileSync(out, JSON.stringify(priv), { mode: 0o600 });
console.log('LICENSE_PUBLIC_JWK for src/config.ts:');
console.log(JSON.stringify({ kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }));
console.log(`private key written to ${out} — upload with: npx wrangler secret put LICENSE_PRIVATE_JWK < ${out}`);
