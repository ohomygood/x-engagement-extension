/**
 * Pro license. The Worker returns a token = base64url(payload) + "." + base64url(ECDSA-P256-SHA256 signature).
 * The extension verifies it OFFLINE with the embedded public key; the only network request the extension
 * ever makes is activation/refresh (POST /activate), at most once per 30 days.
 */
export interface LicensePayload { key: string; plan: 'pro'; device: string; iat: number; exp: number }

const enc = new TextEncoder();

export function b64urlEncode(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const p = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(p), (c) => c.charCodeAt(0));
}

export async function verifyToken(token: string, publicJwk: JsonWebKey, now = Date.now()): Promise<LicensePayload | null> {
  const [p, sig] = (token || '').split('.');
  if (!p || !sig) return null;
  try {
    const key = await crypto.subtle.importKey('jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64urlDecode(sig), enc.encode(p));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p))) as LicensePayload;
    if (payload.plan !== 'pro' || payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function signToken(payload: LicensePayload, privateJwk: JsonWebKey): Promise<string> {
  const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const p = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(p));
  return `${p}.${b64urlEncode(sig)}`;
}

export const KEY_RE = /^XENG(-[A-Z0-9]{4}){3,4}$/;   // 3 groups: card payment; 4 groups: manual (WeChat)

export async function activate(apiBase: string, key: string, device: string, fetchImpl: typeof fetch = fetch):
    Promise<{ token?: string; error?: string }> {
  const k = key.trim().toUpperCase();
  if (!KEY_RE.test(k)) return { error: 'invalid-key-format' };
  try {
    const r = await fetchImpl(`${apiBase}/activate`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                       body: JSON.stringify({ key: k, device }) });
    const j = await r.json() as { token?: string; error?: string };
    return r.ok ? { token: j.token } : { error: j.error || `http-${r.status}` };
  } catch {
    return { error: 'network' };
  }
}
