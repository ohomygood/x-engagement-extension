/**
 * X Engagement List — license Worker (Cloudflare Workers + KV). PLACEHOLDER CONFIG: not deployed.
 *
 *   GET  /paid?session_id   Payment Link after-payment redirect (alias /claim). Retrieves the Checkout Session
 *                           from the Stripe API with the read-only STRIPE_RESTRICTED_KEY, verifies it (complete,
 *                           paid, our payment link, 499 usd incl. both Adaptive Pricing shapes), then issues the
 *                           license key once per session and shows it (zh/en).
 *   POST /stripe/webhook   OPTIONAL backup: checkout.session.completed / async_payment_succeeded → same API
 *                           re-check + same issuance (keys are derived from the session id, so both routes
 *                           yield the same key); charge.refunded revokes.
 *   POST /activate          {key, device} → signed 30-day token (max 3 devices per key).
 *   POST /admin/issue       cashier: issue a key for a manual (WeChat) payment; idempotent per channel+ref
 *   POST /admin/revoke      cashier: revoke a key            (both: Authorization: Bearer ADMIN_TOKEN ≥ 32 chars)
 *   GET  /admin/log         recent admin log entries (append-only KV keys adminlog:<ts>:<rand>; each action is
 *                           also console.log'd as `ADMIN_AUDIT {json}` for Cloudflare Workers logs)
 *   GET  /health, GET /
 *
 * Stores no e-mail or name: only key → {status, devices, created, session, paymentIntent, ref}.
 * Without STRIPE_RESTRICTED_KEY + PAYMENT_LINK_ID no key is ever issued.
 *
 * SURVIVING A WIPED STORE (Render free disk): no key depends on local state to stay valid.
 *  * Stripe keys = HMAC(server signing key, session id). /paid always re-derives and re-shows the key.
 *    /activate with an unknown 3-group key lists our Payment Link's completed sessions from Stripe
 *    (Checkout Sessions: Read), re-derives their keys and rebuilds the matching record (throttled, cached).
 *  * Refunds: the charge is re-checked in Stripe (GET /v1/charges?payment_intent=…, needs Charges: Read) when a
 *    record is (re)built and at most every 24 h on activation; a fully refunded payment revokes the key. Without
 *    Charges: Read this degrades to "unavailable" (key stays valid) — revoke refunded keys via REVOKED_REFS.
 *  * Admin (WeChat) keys are 4-group and self-verifying: XENG-<id 8>-<mac 8>, id = HMAC(channel:ref),
 *    mac = HMAC(id), 40-bit MAC under the server key. A wiped store still accepts them.
 *  * Durable revocations: env REVOKED_REFS (comma/space list of keys, cs_ session ids, pi_ payment intents or
 *    <channel>:<ref>), checked on every /paid and /activate. KV revocations are lost on a wipe.
 *  * Device lists (max 3) live in the store and restart from zero after a wipe.
 */
import { signToken, type LicensePayload } from '../../src/license';

export interface Env {
  LICENSES: KVNamespace;
  STRIPE_RESTRICTED_KEY?: string;  // rk_… read-only, "Checkout Sessions: Read" (wrangler secret)
  PAYMENT_LINK_ID?: string;        // plink_… of https://buy.stripe.com/8x2bJ2gbY8bLfiC2hT0Ny03
  EXPECTED_AMOUNT?: string;        // default "499" (cents)
  EXPECTED_CURRENCY?: string;      // default "usd"
  STRIPE_WEBHOOK_SECRET?: string;  // whsec_… optional backup route (wrangler secret)
  ADMIN_TOKEN?: string;            // openssl rand -hex 32 (wrangler secret). Unset/short → /admin/* is 404.
  LICENSE_PRIVATE_JWK: string;     // JSON JWK from scripts/keygen.mjs (wrangler secret)
  ALLOWED_ORIGINS?: string;        // comma list, e.g. "chrome-extension://<id>"; empty = allow any chrome-extension://
  MAX_DEVICES?: string;
  REVOKED_REFS?: string;           // durable revocations, see header
}

export interface LicenseRecord {
  status: 'active' | 'revoked'; devices: string[]; created: number; session: string; paymentIntent?: string;
  ref?: string; source?: 'paid-redirect' | 'webhook' | 'admin';
  manual?: { channel: string; amount: number | null; currency: string | null; ref: string; by: string };
  revokedBy?: string; revokedReason?: string;
  recovered?: boolean; refundCheck?: { at: number; status: RefundStatus };
}
export type RefundStatus = 'ok' | 'refunded' | 'unavailable' | 'error' | 'n/a';

const REFUND_RECHECK_MS = 86_400_000;      // re-check a Stripe key's charge for refunds at most daily
const SCAN_MIN_INTERVAL_MS = 30_000;       // unknown-key lookups hit Stripe's session list at most this often
const SCAN_MAX_PAGES = 20;
const SESSION_RE = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
const REF_RE = /^[A-Za-z0-9_-]{8,64}$/;

export class PayError extends Error {
  constructor(public reason: string, public http = 402, public detail = '') { super(detail ? `${reason}: ${detail}` : reason); }
}

export interface StripeSession {
  id: string; object: string; mode?: string; status?: string; payment_status?: string; payment_link?: string | null;
  amount_total?: number | null; currency?: string | null; client_reference_id?: string | null; payment_intent?: string | null;
  livemode?: boolean; created?: number; currency_conversion?: { amount_total?: number; source_currency?: string } | null;
  presentment_details?: { presentment_amount?: number; presentment_currency?: string } | null;
}

function stripeKey(env: Env): string {
  const key = (env.STRIPE_RESTRICTED_KEY || '').trim();
  if (!key) throw new PayError('not_configured', 503, 'STRIPE_RESTRICTED_KEY missing');
  // Only restricted keys. Any rk_ key with Checkout Sessions: Read works (Charges: Read additionally enables the
  // refund check); full sk_ secret keys and anything else are refused.
  if (!key.startsWith('rk_')) throw new PayError('not_configured', 503, 'use a restricted rk_ key');
  return key;
}

/** GET a Stripe API path (read-only). Maps HTTP errors to PayError. */
async function stripeGet(path: string, env: Env, fetchImpl: typeof fetch): Promise<unknown> {
  const key = stripeKey(env);
  let r: Response;
  try {
    r = await fetchImpl(`https://api.stripe.com/v1/${path}`, { headers: { Authorization: `Bearer ${key}` } });
  } catch { throw new PayError('stripe_unreachable', 502); }
  if (r.status === 404) throw new PayError('session_not_found', 404);
  if (r.status === 401 || r.status === 403) throw new PayError('stripe_auth', 503, `HTTP ${r.status}`);
  if (r.status !== 200) throw new PayError('stripe_error', 502, `HTTP ${r.status}`);
  return r.json();
}

export async function fetchSession(sid: string, env: Env, fetchImpl: typeof fetch = fetch): Promise<StripeSession> {
  if (!SESSION_RE.test(sid)) throw new PayError('bad_session_id', 400);
  return await stripeGet(`checkout/sessions/${sid}`, env, fetchImpl) as StripeSession;
}

/** Was this payment fully refunded? Needs Charges: Read; degrades to 'unavailable' without it. */
export async function refundStatus(pi: string | undefined, env: Env, fetchImpl: typeof fetch = fetch): Promise<RefundStatus> {
  if (!pi || !/^pi_[A-Za-z0-9]{1,100}$/.test(pi)) return 'n/a';
  try {
    const j = await stripeGet(`charges?payment_intent=${encodeURIComponent(pi)}&limit=10`, env, fetchImpl) as
      { data?: { refunded?: boolean; amount?: number; amount_refunded?: number; status?: string }[] };
    const ch = (j.data || []).filter((c) => c.status === 'succeeded' || c.refunded);
    if (ch.some((c) => c.refunded === true || (Number(c.amount) > 0 && Number(c.amount_refunded) >= Number(c.amount)))) return 'refunded';
    return 'ok';
  } catch (e) {
    if (e instanceof PayError && e.reason === 'stripe_auth') return 'unavailable';
    return 'error';
  }
}

/** Throws unless this is a complete, paid $4.99 purchase through our Payment Link. */
export function verifySession(s: StripeSession, sid: string, env: Env): void {
  if (s.object !== 'checkout.session' || s.id !== sid) throw new PayError('session_mismatch', 400);
  if (!(env.PAYMENT_LINK_ID || '').startsWith('plink_')) throw new PayError('not_configured', 503, 'PAYMENT_LINK_ID missing');
  if (s.payment_link !== env.PAYMENT_LINK_ID) throw new PayError('wrong_payment_link');
  if (s.mode !== 'payment' || s.status !== 'complete' || s.payment_status !== 'paid') throw new PayError('not_paid');
  // Adaptive Pricing: API ≥ 2025-03-31 keeps amount_total/currency in the integration currency (buyer's local
  // amount is in presentment_details); older API versions put local values at top level + currency_conversion.
  const cc = s.currency_conversion;
  const [amt, cur] = cc?.source_currency ? [cc.amount_total, cc.source_currency] : [s.amount_total, s.currency];
  if (amt !== Number(env.EXPECTED_AMOUNT || 499) || String(cur || '').toLowerCase() !== (env.EXPECTED_CURRENCY || 'usd').toLowerCase())
    throw new PayError('wrong_amount', 402, `${amt} ${cur}`);
  if (s.client_reference_id && !REF_RE.test(s.client_reference_id)) throw new PayError('bad_reference', 400);
}

/** Deterministic key per session (HMAC with the signing key's private scalar): concurrent redirect + webhook can't mint two keys. */
export async function deriveKey(sid: string, env: Env): Promise<string> {
  const d = (JSON.parse(env.LICENSE_PRIVATE_JWK) as JsonWebKey).d;
  if (!d) throw new PayError('not_configured', 503, 'LICENSE_PRIVATE_JWK has no d');
  const k = await crypto.subtle.importKey('raw', enc.encode('xeng-key-v1:' + d), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const b = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(sid)));
  const c = Array.from(b.slice(0, 12), (x) => ALPHABET[x % 32]).join('');
  return `XENG-${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}`;
}

async function hmacChars(label: string, msg: string, env: Env, n: number): Promise<string> {
  const d = (JSON.parse(env.LICENSE_PRIVATE_JWK) as JsonWebKey).d;
  if (!d) throw new PayError('not_configured', 503, 'LICENSE_PRIVATE_JWK has no d');
  const k = await crypto.subtle.importKey('raw', enc.encode(`${label}:${d}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const b = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
  return Array.from(b.slice(0, n), (x) => ALPHABET[x % 32]).join('');
}

/** Admin (WeChat) key: deterministic per channel+ref AND self-verifying (valid without any stored record). */
export async function deriveAdminKey(channel: string, ref: string, env: Env): Promise<string> {
  const id = await hmacChars('xeng-admin-id-v1', `${channel}:${ref}`, env, 8);
  const mac = await hmacChars('xeng-admin-mac-v1', id, env, 8);
  return `XENG-${id.slice(0, 4)}-${id.slice(4)}-${mac.slice(0, 4)}-${mac.slice(4)}`;
}

export async function isAdminKey(key: string, env: Env): Promise<boolean> {
  const m = /^XENG-([A-Z0-9]{4})-([A-Z0-9]{4})-([A-Z0-9]{4})-([A-Z0-9]{4})$/.exec(key);
  if (!m) return false;
  return safeEq(await hmacChars('xeng-admin-mac-v1', m[1] + m[2], env, 8), m[3] + m[4]);
}

/** Durable revocation list from env REVOKED_REFS: keys, cs_ sessions, pi_ intents, <channel>:<ref>. */
const revokedCache = new Map<string, Promise<{ keys: Set<string>; pis: Set<string> }>>();
export function revokedSet(env: Env): Promise<{ keys: Set<string>; pis: Set<string> }> {
  const raw = (env.REVOKED_REFS || '').trim();
  const ck = raw + '|' + (env.LICENSE_PRIVATE_JWK || '').length;
  let p = revokedCache.get(ck);
  if (!p) {
    p = (async () => {
      const keys = new Set<string>(), pis = new Set<string>();
      for (const t of raw.split(/[\s,]+/).filter(Boolean)) {
        if (KEY_RE.test(t.toUpperCase())) keys.add(t.toUpperCase());
        else if (SESSION_RE.test(t)) keys.add(await deriveKey(t, env));
        else if (/^pi_[A-Za-z0-9]{1,100}$/.test(t)) pis.add(t);
        else if (/^[a-z]+:[A-Za-z0-9_\-.:/#]{1,100}$/.test(t)) {
          const [ch, ...rest] = t.split(':'); const ref = rest.join(':');
          keys.add(await deriveAdminKey(ch, ref, env));
          keys.add(await deriveKey(`admin:${ch}:${ref}`, env));     // pre-v2 admin keys
        }
      }
      return { keys, pis };
    })();
    if (revokedCache.size > 20) revokedCache.clear();
    revokedCache.set(ck, p);
  }
  return p;
}
async function isRevokedByEnv(key: string, rec: LicenseRecord | null, env: Env): Promise<boolean> {
  if (!env.REVOKED_REFS) return false;
  const r = await revokedSet(env);
  return r.keys.has(key) || (!!rec?.paymentIntent && r.pis.has(rec.paymentIntent));
}

/** Refund re-check for Stripe-paid records; a fully refunded payment revokes the key (persisted + logged). */
async function refreshRefund(key: string, rec: LicenseRecord, env: Env, fetchImpl: typeof fetch, force = false): Promise<LicenseRecord> {
  if (rec.status !== 'active' || !rec.paymentIntent || rec.source === 'admin') return rec;
  if (!force && rec.refundCheck && Date.now() - rec.refundCheck.at < REFUND_RECHECK_MS) return rec;
  const status = await refundStatus(rec.paymentIntent, env, fetchImpl);
  const next: LicenseRecord = { ...rec, refundCheck: { at: Date.now(), status } };
  if (status === 'refunded') Object.assign(next, { status: 'revoked', revokedBy: 'stripe', revokedReason: 'refunded' });
  await putRec(env, key, next);
  return next;
}

/** Recovery scan state (in memory; the rebuilt records are written back to the store). */
const scan = { last: 0, createdMax: 0, map: new Map<string, StripeSession>(), link: '' };
export function _resetRecovery() { scan.last = 0; scan.createdMax = 0; scan.map.clear(); scan.link = ''; revokedCache.clear(); }

/** Unknown 3-group key after a wipe: find its session among our Payment Link's completed sessions. */
async function findSessionForKey(key: string, env: Env, fetchImpl: typeof fetch): Promise<StripeSession | null> {
  if (scan.link !== (env.PAYMENT_LINK_ID || '')) { scan.map.clear(); scan.createdMax = 0; scan.link = env.PAYMENT_LINK_ID || ''; }
  if (scan.map.has(key)) return scan.map.get(key)!;
  if (!env.PAYMENT_LINK_ID || Date.now() - scan.last < SCAN_MIN_INTERVAL_MS) return null;
  scan.last = Date.now();
  let after = ''; const since = scan.createdMax;
  try {
    for (let page = 0; page < SCAN_MAX_PAGES; page++) {
      const q = `checkout/sessions?payment_link=${encodeURIComponent(env.PAYMENT_LINK_ID)}&status=complete&limit=100` +
        (since ? `&created[gte]=${since}` : '') + (after ? `&starting_after=${encodeURIComponent(after)}` : '');
      const j = await stripeGet(q, env, fetchImpl) as { data?: StripeSession[]; has_more?: boolean };
      for (const s of j.data || []) {
        try { verifySession(s, s.id, env); } catch { continue; }
        scan.map.set(await deriveKey(s.id, env), s);
        if (s.created && s.created > scan.createdMax) scan.createdMax = s.created;
      }
      if (!j.has_more || !j.data?.length) break;
      after = j.data[j.data.length - 1].id;
    }
  } catch (e) {
    if (!(e instanceof PayError)) throw e;
    auditLine(env, { ts: new Date().toISOString(), event: 'recovery_scan_failed', reason: e.reason });
    return null;
  }
  return scan.map.get(key) || null;
}

/** Store record for a verified session (deterministic key), shared by redeem and recovery. */
async function writeSessionRecord(s: StripeSession, env: Env, source: LicenseRecord['source'], recovered: boolean) {
  const key = await deriveKey(s.id, env);
  const pi = s.payment_intent ? String(s.payment_intent) : undefined;
  const rec: LicenseRecord = { status: 'active', devices: [], created: Date.now(), session: s.id, paymentIntent: pi,
                               ref: s.client_reference_id || undefined, source, ...(recovered ? { recovered: true } : {}) };
  await putRec(env, key, rec);
  await env.LICENSES.put(`session:${s.id}`, key);
  if (pi) await env.LICENSES.put(`pi:${pi}`, key);
  return { key, rec };
}

/** API-verify then issue once. status 'issued' = new key; 'existing' = session already redeemed. */
export async function redeem(sid: string, env: Env, source: 'paid-redirect' | 'webhook', fetchImpl: typeof fetch = fetch):
    Promise<{ key: string; status: 'issued' | 'existing'; rec: LicenseRecord }> {
  const s = await fetchSession(sid, env, fetchImpl);
  verifySession(s, sid, env);
  const prev = await env.LICENSES.get(`session:${sid}`);
  if (prev) {
    const rec = await getRec(env, prev);
    if (rec) return { key: prev, status: 'existing', rec };
  }
  const { key, rec } = await writeSessionRecord(s, env, source, false);
  return { key, status: 'issued', rec };
}

const TOKEN_DAYS = 30;
const KEY_RE = /^XENG(-[A-Z0-9]{4}){3,4}$/;     // 3 groups: Stripe; 4 groups: admin (self-verifying)
const isStripeFormat = (k: string) => /^XENG(-[A-Z0-9]{4}){3}$/.test(k);
const DEVICE_RE = /^[A-Za-z0-9-]{8,64}$/;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

export function newKey(): string {
  const b = crypto.getRandomValues(new Uint8Array(12));
  const c = Array.from(b, (x) => ALPHABET[x % 32]).join('');
  return `XENG-${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}`;
}

const enc = new TextEncoder();
function hex(buf: ArrayBuffer) { return Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, '0')).join(''); }
function safeEq(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Stripe-Signature: t=<unix>,v1=<hex hmac sha256 of `${t}.${body}`>; 5-minute tolerance. */
export async function verifyStripe(body: string, header: string | null, secret: string, nowSec = Date.now() / 1000): Promise<boolean> {
  if (!header || !secret) return false;
  const parts = header.split(',').map((p) => p.split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !sigs.length || Math.abs(nowSec - Number(t)) > 300) return false;
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = hex(await crypto.subtle.sign('HMAC', k, enc.encode(`${t}.${body}`)));
  return sigs.some((s) => safeEq(s, mac));
}

function cors(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ok = allowed.length ? allowed.includes(origin) : origin.startsWith('chrome-extension://');
  return ok ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' } : {};
}
const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...extra } });

async function getRec(env: Env, key: string) { return env.LICENSES.get<LicenseRecord>(`key:${key}`, 'json'); }
async function putRec(env: Env, key: string, rec: LicenseRecord) { await env.LICENSES.put(`key:${key}`, JSON.stringify(rec)); }

async function webhook(req: Request, env: Env): Promise<Response> {
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: 'webhook-not-configured' }, 503);
  const body = await req.text();
  if (!(await verifyStripe(body, req.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET))) return json({ error: 'bad-signature' }, 400);
  let ev: { type: string; data: { object: Record<string, unknown> } };
  try { ev = JSON.parse(body); } catch { return json({ error: 'bad-json' }, 400); }
  const o = ev.data?.object || {};
  if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') {
    try {
      // a signed event is still re-checked against the API, through the same single-use issuance as /paid
      const r = await redeem(String(o.id || ''), env, 'webhook');
      return json({ ok: true, status: r.status });
    } catch (e) {
      if (!(e instanceof PayError)) throw e;
      return json({ ok: false, reason: e.reason }, e.http >= 500 ? 503 : 200);   // 5xx → Stripe retries later
    }
  }
  if (ev.type === 'charge.refunded' && o.payment_intent) {
    const key = await env.LICENSES.get(`pi:${String(o.payment_intent)}`);
    const rec = key && await getRec(env, key);
    if (key && rec) await putRec(env, key, { ...rec, status: 'revoked' });
    return json({ ok: true, revoked: !!rec });
  }
  return json({ ok: true, ignored: ev.type });
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const PAY_MSG: Record<string, [string, string]> = {
  not_configured: ['付款验证尚未开通，暂时无法发放激活码。你的付款不会丢失，请联系我们。', "Payment verification isn't switched on yet, so we can't issue your key right now. Your payment is safe; please contact us."],
  bad_session_id: ['链接参数无效。', 'The payment reference in this link is invalid.'],
  session_not_found: ['没有找到这笔付款。', "We couldn't find this payment."],
  not_paid: ['这笔付款尚未完成，完成后请刷新本页。', "This payment isn't complete yet. Refresh this page once it is."],
  wrong_payment_link: ['这笔付款不是 Pro 订单。', "This payment isn't a Pro order."],
  wrong_amount: ['付款金额与订单不符。', "The amount paid doesn't match the order."],
  revoked: ['这笔付款已退款，激活码已失效。', 'This payment was refunded and its key is no longer valid.'],
};
function page(inner: string, status: number): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
    <meta name="robots" content="noindex"><title>X Engagement List Pro</title>
    <body style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.6">${inner}
    <p style="color:#667">联系我们 / Contact: <a href="mailto:go_with_prob@mail.grokbot.com">go_with_prob@mail.grokbot.com</a></p></body>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

async function paid(url: URL, env: Env, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const sid = url.searchParams.get('session_id') || '';
  try {
    const { key, rec: rec0 } = await redeem(sid, env, 'paid-redirect', fetchImpl);
    // the key is derived from the session, so this page can always re-show it (also after a store wipe)
    // re-check the refund status on every visit (one extra read call): re-opening this page after a refund
    // revokes the key immediately instead of waiting for the daily activation re-check
    const rec = await refreshRefund(key, rec0, env, fetchImpl, true);
    if (rec.status !== 'active' || await isRevokedByEnv(key, rec, env)) throw new PayError('revoked', 410);
    return page(`<h1>感谢购买 X 互动名单助手 Pro / Thanks for buying Pro</h1><p>你的激活码 / Your license key:</p>
       <p><code style="font-size:22px;user-select:all">${esc(key)}</code></p>
       <p>打开扩展 → 设置 → 输入激活码。最多 3 台设备。7 天内可退款。<br>Open the extension → Settings → paste the key. Up to 3 devices. 7-day refund.</p>
       <p>请保存激活码，或收藏本页链接（随时可重新打开查看）；我们不保存你的邮箱。<br>Save this key, or bookmark this page (you can reopen it any time). We don't store your e-mail.</p>`, 200);
  } catch (e) {
    if (!(e instanceof PayError)) throw e;
    const [zh, en] = PAY_MSG[e.reason] || ['验证付款时出错，请稍后刷新重试。', 'Something went wrong verifying the payment. Refresh to retry in a moment.'];
    return page(`<h1>付款验证 / Payment check</h1><p>${zh}</p><p>${en}</p><p style="color:#667">Ref: <code>${esc(e.reason)}</code></p>`, e.http);
  }
}

async function activateRoute(req: Request, env: Env, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const h = cors(req, env);
  let body: { key?: unknown; device?: unknown };
  try { body = await req.json(); } catch { return json({ error: 'bad-json' }, 400, h); }
  const key = String(body.key || '').trim().toUpperCase();
  const device = String(body.device || '');
  if (!KEY_RE.test(key) || !DEVICE_RE.test(device)) return json({ error: 'invalid-input' }, 400, h);
  let rec = await getRec(env, key);
  if (await isRevokedByEnv(key, rec, env)) return json({ error: 'revoked' }, 403, h);
  if (!rec) {
    // store wiped (or never seen here): rebuild from proof that doesn't depend on local state
    if (await isAdminKey(key, env)) {
      rec = { status: 'active', devices: [], created: Date.now(), session: 'admin:recovered', source: 'admin', recovered: true };
      await putRec(env, key, rec);
    } else if (isStripeFormat(key)) {
      const s = await findSessionForKey(key, env, fetchImpl);
      if (s) rec = (await writeSessionRecord(s, env, 'paid-redirect', true)).rec;
    }
    if (!rec) return json({ error: 'unknown-key' }, 404, h);
    if (await isRevokedByEnv(key, rec, env)) return json({ error: 'revoked' }, 403, h);
  }
  if (rec.status === 'active') rec = await refreshRefund(key, rec, env, fetchImpl);
  if (rec.status !== 'active') return json({ error: 'revoked' }, 403, h);
  const max = Number(env.MAX_DEVICES || 3);
  if (!rec.devices.includes(device)) {
    if (rec.devices.length >= max) return json({ error: 'device-limit' }, 403, h);
    rec.devices.push(device);
    await putRec(env, key, rec);
  }
  const now = Date.now();
  const payload: LicensePayload = { key, plan: 'pro', device, iat: now, exp: now + TOKEN_DAYS * 86_400_000 };
  const token = await signToken(payload, JSON.parse(env.LICENSE_PRIVATE_JWK) as JsonWebKey);
  return json({ token, exp: payload.exp }, 200, h);
}

// ---------------------------------------------------------------- admin (manual WeChat payments)
const ADMIN_MIN_LEN = 32;
const FAIL_TTL = 900;            // seconds
const FAIL_PER_IP = 5;
const FAIL_GLOBAL = 20;
const CHANNELS = new Set(['wechat', 'alipay', 'bank', 'stripe', 'comp', 'other']);
const CURRENCIES = new Set(['CNY', 'USD', 'HKD', 'EUR']);
const TEXT_RE = /^[^\x00-\x1f\x7f]{1,200}$/;
const ADMIN_REF_RE = /^[A-Za-z0-9_\-.:/#]{1,100}$/;

class AdminError extends Error { constructor(msg: string, public http = 400) { super(msg); } }

async function sha256(s: string) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }

/** Constant-time token check with KV-backed lockout (per IP and global). Never logs the token. */
async function adminAuth(req: Request, env: Env): Promise<void> {
  const want = env.ADMIN_TOKEN || '';
  if (want.length < ADMIN_MIN_LEN) throw new AdminError('not-found', 404);
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const ipKey = `adminfail:ip:${ip}`;
  const [ipFails, allFails] = await Promise.all([env.LICENSES.get(ipKey), env.LICENSES.get('adminfail:all')]);
  if (Number(ipFails || 0) >= FAIL_PER_IP || Number(allFails || 0) >= FAIL_GLOBAL) throw new AdminError('locked', 429);
  const h = req.headers.get('Authorization') || '';
  const got = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!safeEq(await sha256(got), await sha256(want))) {
    await env.LICENSES.put(ipKey, String(Number(ipFails || 0) + 1), { expirationTtl: FAIL_TTL });
    await env.LICENSES.put('adminfail:all', String(Number(allFails || 0) + 1), { expirationTtl: FAIL_TTL });
    auditLine(env, { ts: new Date().toISOString(), event: 'admin_auth_failed', ip });
    throw new AdminError('unauthorized', 401);
  }
}

async function adminLog(env: Env, rec: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const id = hex(crypto.getRandomValues(new Uint8Array(6)).buffer as ArrayBuffer);
  const line = { ts, ...rec };
  // append-only: every entry is a new, never-overwritten key
  await env.LICENSES.put(`adminlog:${ts}:${id}`, JSON.stringify(line));
  auditLine(env, { event: 'admin', ...line });
}

/** One `ADMIN_AUDIT {json}` line per admin action, kept in Cloudflare Workers logs. Secrets are scrubbed defensively. */
export function auditLine(env: Env, rec: Record<string, unknown>) {
  let out = JSON.stringify(rec);
  for (const v of [env.ADMIN_TOKEN, env.STRIPE_RESTRICTED_KEY, env.STRIPE_WEBHOOK_SECRET])
    if (v && v.length >= 8) out = out.split(v).join('REDACTED');
  console.log('ADMIN_AUDIT ' + out);
}

function text(v: unknown, field: string): string {
  const s = String(v ?? '').trim();
  if (!TEXT_RE.test(s)) throw new AdminError(`'${field}' is required (one line, max 200 chars)`);
  return s;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    if (b && typeof b === 'object' && !Array.isArray(b)) return b as Record<string, unknown>;
  } catch { /* fallthrough */ }
  throw new AdminError('bad-json');
}

async function adminIssue(req: Request, env: Env): Promise<Response> {
  const b = await readBody(req);
  const by = text(b.by, 'by'), reason = text(b.reason, 'reason');
  const channel = String(b.channel || 'comp').toLowerCase();
  if (!CHANNELS.has(channel)) throw new AdminError('bad channel');
  const ref = String(b.ref ?? '').trim();
  if (!ADMIN_REF_RE.test(ref)) throw new AdminError("'ref' (payment transaction id / note) is required: letters, digits, _-.:/# max 100");
  let amount: number | null = null;
  if (b.amount !== undefined && b.amount !== null && b.amount !== '') {
    amount = Math.round(Number(b.amount) * 100) / 100;
    if (!Number.isFinite(amount) || amount < 0 || amount > 100000) throw new AdminError('bad amount');
  }
  const currency = b.currency ? String(b.currency).toUpperCase() : (channel === 'wechat' || channel === 'alipay' ? 'CNY' : null);
  if (currency && !CURRENCIES.has(currency)) throw new AdminError('bad currency');
  const install = b.install ? String(b.install) : undefined;
  if (install && !REF_RE.test(install)) throw new AdminError('bad install id');
  const refKey = `adminref:${channel}:${ref}`;
  const base = { action: 'issue', by, reason, channel, amount, currency, ref, install: install || null, source: String(b.source || 'endpoint').slice(0, 16) };
  const existing = await env.LICENSES.get(refKey);
  if (existing) {
    await adminLog(env, { ...base, key: existing, result: 'existing' });
    return json({ result: 'existing', key: existing });
  }
  // deterministic per channel+ref (two concurrent calls for one WeChat ref yield the same single key) and
  // self-verifying, so it stays valid after a store wipe
  const key = await deriveAdminKey(channel, ref, env);
  const rec: LicenseRecord = { status: 'active', devices: [], created: Date.now(), session: `admin:${channel}:${ref}`,
                               ref: install, source: 'admin', manual: { channel, amount, currency, ref, by } };
  await putRec(env, key, rec);
  await env.LICENSES.put(refKey, key);
  await adminLog(env, { ...base, key, result: 'issued' });
  return json({ result: 'issued', key });
}

async function adminRevoke(req: Request, env: Env): Promise<Response> {
  const b = await readBody(req);
  const by = text(b.by, 'by'), reason = text(b.reason, 'reason');
  const key = String(b.key || '').trim().toUpperCase();
  if (!KEY_RE.test(key)) throw new AdminError('bad key');
  const rec = await getRec(env, key);
  const result = !rec ? 'not_found' : rec.status === 'revoked' ? 'already_revoked' : 'revoked';
  if (rec && result === 'revoked') await putRec(env, key, { ...rec, status: 'revoked', revokedBy: by, revokedReason: reason });
  let rec2 = rec;
  if (!rec && (await isAdminKey(key, env) || (isStripeFormat(key) && await findSessionForKey(key, env, fetch)))) {
    // valid key whose record was wiped: record the revocation anyway
    rec2 = { status: 'revoked', devices: [], created: Date.now(), session: 'recovered', recovered: true, revokedBy: by, revokedReason: reason };
    await putRec(env, key, rec2);
  }
  const res = !rec2 ? 'not_found' : result === 'not_found' ? 'revoked' : result;
  const durable = rec2?.manual ? `${rec2.manual.channel}:${rec2.manual.ref}` : rec2?.session?.startsWith('cs_') ? rec2.session : key;
  await adminLog(env, { action: 'revoke', by, reason, key, ref: b.ref ? String(b.ref).slice(0, 100) : null,
                        source: String(b.source || 'endpoint').slice(0, 16), result: res, durable });
  // KV is wiped on Render free restarts: the caller should add `durable` to REVOKED_REFS to make it permanent
  return json({ result: res, add_to_REVOKED_REFS: res === 'not_found' ? undefined : durable }, res === 'not_found' ? 404 : 200);
}

async function adminLogList(url: URL, env: Env): Promise<Response> {
  const limit = Math.min(Number(url.searchParams.get('limit') || 100), 1000);
  const list = await env.LICENSES.list({ prefix: 'adminlog:', limit: 1000 });
  const keys = list.keys.map((k) => k.name).sort().slice(-limit);
  const entries = await Promise.all(keys.map((k) => env.LICENSES.get(k, 'json')));
  return json({ entries });
}

async function adminRoute(req: Request, url: URL, env: Env): Promise<Response> {
  try {
    await adminAuth(req, env);
    if (url.pathname === '/admin/issue' && req.method === 'POST') return await adminIssue(req, env);
    if (url.pathname === '/admin/revoke' && req.method === 'POST') return await adminRevoke(req, env);
    if (url.pathname === '/admin/log' && req.method === 'GET') return await adminLogList(url, env);
    return json({ error: 'not-found' }, 404);
  } catch (e) {
    if (e instanceof AdminError) return json({ error: e.message }, e.http);
    throw e;
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req, env) });
    if (url.pathname === '/stripe/webhook' && req.method === 'POST') return webhook(req, env);
    if (url.pathname === '/activate' && req.method === 'POST') return activateRoute(req, env);
    if (url.pathname === '/' && req.method === 'GET') return json({ service: 'xeng-license', health: '/health' });
    if ((url.pathname === '/paid' || url.pathname === '/claim') && req.method === 'GET') return paid(url, env);
    if (url.pathname.startsWith('/admin/')) return adminRoute(req, url, env);
    if (url.pathname === '/health') return json({ ok: true,
      payments_configured: (env.STRIPE_RESTRICTED_KEY || '').startsWith('rk_') && (env.PAYMENT_LINK_ID || '').startsWith('plink_'),
      admin_enabled: (env.ADMIN_TOKEN || '').length >= ADMIN_MIN_LEN, revoked_refs: !!env.REVOKED_REFS });
    return json({ error: 'not-found' }, 404);
  },
} satisfies ExportedHandler<Env>;
