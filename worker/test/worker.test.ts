// @vitest-environment node
import worker, { _resetRecovery, deriveAdminKey, deriveKey, isAdminKey, newKey, verifyStripe, type Env, type LicenseRecord, type StripeSession } from '../src/index';
import { verifyToken } from '../../src/license';

class MemKV {
  m = new Map<string, string>();
  async get(k: string, type?: string) { const v = this.m.get(k); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; }
  async put(k: string, v: string, _o?: unknown) { this.m.set(k, v); }
  async list({ prefix = '' }: { prefix?: string; limit?: number } = {}) {
    return { keys: [...this.m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
  }
}
const SECRET = 'whsec_test';
const ORIGIN = 'chrome-extension://abcdefghijklmnop';
const enc = new TextEncoder();
async function sign(body: string, t = Math.floor(Date.now() / 1000), secret = SECRET) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(`${t}.${body}`))), (x) => x.toString(16).padStart(2, '0')).join('');
  return `t=${t},v1=${mac}`;
}

let env: Env & { LICENSES: MemKV }; let pub: JsonWebKey;
beforeEach(async () => {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  pub = await crypto.subtle.exportKey('jwk', kp.publicKey);
  env = { LICENSES: new MemKV(), STRIPE_WEBHOOK_SECRET: SECRET, ALLOWED_ORIGINS: ORIGIN,
          STRIPE_RESTRICTED_KEY: 'rk_test_readonly', PAYMENT_LINK_ID: LINK,
          LICENSE_PRIVATE_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey)) } as never;
});
const call = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://license.test${path}`, init) as never, env);
async function hook(event: unknown, sig?: string) {
  const body = JSON.stringify(event);
  return call('/stripe/webhook', { method: 'POST', body, headers: { 'Stripe-Signature': sig ?? await sign(body) } });
}
const SID = 'cs_test_a1b2c3d4e5f6';
const LINK = 'plink_1ProLinkTest';
const INSTALL = '3f2b8c1e-1111-4222-8333-123456789abc';
const paid = { type: 'checkout.session.completed', data: { object: { id: SID, payment_status: 'paid' } } };
const session = (o: Partial<StripeSession> = {}): StripeSession => ({ id: SID, object: 'checkout.session', mode: 'payment',
  status: 'complete', payment_status: 'paid', payment_link: LINK, amount_total: 499, currency: 'usd',
  client_reference_id: INSTALL, payment_intent: 'pi_1', livemode: false, ...o });
type Charge = { id: string; status: string; amount: number; amount_refunded: number; refunded: boolean };
let sessions: Record<string, StripeSession>; let apiCalls: { url: string; auth: string | null }[];
let charges: Record<string, Charge[]>; let chargesStatus: number;
const charge = (o: Partial<Charge> = {}): Charge => ({ id: 'ch_1', status: 'succeeded', amount: 499, amount_refunded: 0, refunded: false, ...o });
beforeEach(() => {
  sessions = { [SID]: session() }; apiCalls = []; charges = { pi_1: [charge()] }; chargesStatus = 200;
  _resetRecovery();
  // fake Stripe API: GET session, list sessions (by payment link), list charges (by payment intent)
  vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => {
    apiCalls.push({ url: u, auth: new Headers(init?.headers).get('Authorization') });
    const url = new URL(u);
    const ok = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
    if (url.pathname === '/v1/charges') {
      if (chargesStatus !== 200) return ok({ error: {} }, chargesStatus);
      return ok({ data: charges[url.searchParams.get('payment_intent')!] || [], has_more: false });
    }
    if (url.pathname === '/v1/checkout/sessions')
      return ok({ data: Object.values(sessions).filter((s) => s.payment_link === url.searchParams.get('payment_link')), has_more: false });
    const s = sessions[url.pathname.split('/').pop()!];
    return ok(s ?? { error: {} }, s ? 200 : 404);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });
const keyOf = () => env.LICENSES.m.get(`session:${SID}`)!;
const act = (key: string, device: string, origin = ORIGIN) =>
  call('/activate', { method: 'POST', body: JSON.stringify({ key, device }), headers: { Origin: origin, 'Content-Type': 'application/json' } });

describe('license worker', () => {
  it('generates well-formed keys', async () => {
    for (let i = 0; i < 50; i++) expect(newKey()).toMatch(/^XENG-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const k = await deriveKey(SID, env);
    expect(k).toMatch(/^XENG-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(await deriveKey(SID, env)).toBe(k);                 // deterministic per session
    expect(await deriveKey('cs_test_otherotherother', env)).not.toBe(k);
  });

  it('verifies Stripe signatures with tolerance', async () => {
    expect(await verifyStripe('x', await sign('x'), SECRET)).toBe(true);
    expect(await verifyStripe('y', await sign('x'), SECRET)).toBe(false);
    expect(await verifyStripe('x', await sign('x', 1000), SECRET)).toBe(false);
    expect(await verifyStripe('x', await sign('x', undefined, 'other'), SECRET)).toBe(false);
    expect((await hook(paid, 't=1,v1=00')).status).toBe(400);
  });

  it('/paid verifies via the API with the restricted key, issues once, re-shows the same key', async () => {
    const r = await call(`/paid?session_id=${SID}`);
    expect(r.status).toBe(200);
    const key = keyOf();
    expect(key).toMatch(/^XENG-/);
    expect(await r.text()).toContain(key);
    expect(apiCalls).toEqual([{ url: `https://api.stripe.com/v1/checkout/sessions/${SID}`, auth: 'Bearer rk_test_readonly' },
                              { url: 'https://api.stripe.com/v1/charges?payment_intent=pi_1&limit=10', auth: 'Bearer rk_test_readonly' }]);
    const rec = JSON.parse(env.LICENSES.m.get(`key:${key}`)!) as LicenseRecord;
    expect(rec).toMatchObject({ status: 'active', session: SID, paymentIntent: 'pi_1', ref: INSTALL, source: 'paid-redirect' });
    // refresh / old /claim alias: same key, no second record
    expect(await (await call(`/claim?session_id=${SID}`)).text()).toContain(key);
    expect([...env.LICENSES.m.keys()].filter((k) => k.startsWith('key:'))).toHaveLength(1);
    expect([...env.LICENSES.m.values()].join()).not.toMatch(/@/); // no e-mails stored
  });

  it('/paid re-checks refunds on every visit (forces revocation right after a refund)', async () => {
    await call(`/paid?session_id=${SID}`);
    const key = keyOf();
    expect((await act(key, 'device-0001')).status).toBe(200);
    charges.pi_1 = [charge({ amount_refunded: 499, refunded: true })];
    expect((await act(key, 'device-0001')).status).toBe(200);        // activation: cached for 24 h
    expect((await call(`/paid?session_id=${SID}`)).status).toBe(410); // /paid: immediate re-check
    expect(await (await act(key, 'device-0001')).json()).toEqual({ error: 'revoked' });
  });

  it('works for a plain link purchase without client_reference_id (key tied to the session, not the install)', async () => {
    sessions[SID] = session({ client_reference_id: null });
    const r = await call(`/paid?session_id=${SID}`);
    expect(r.status).toBe(200);
    const key = keyOf();
    expect(await r.text()).toContain(key);
    expect((await act(key, 'any-other-device-01')).status).toBe(200);
  });

  it('/paid always re-shows the key (no claim window), also long after issuance', async () => {
    await call(`/paid?session_id=${SID}`);
    const rec = JSON.parse(env.LICENSES.m.get(`key:${keyOf()}`)!) as LicenseRecord;
    env.LICENSES.m.set(`key:${keyOf()}`, JSON.stringify({ ...rec, created: Date.now() - 30 * 86_400_000 }));
    const r = await call(`/paid?session_id=${SID}`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain(keyOf());
  });

  it('/paid rejects sessions that fail any check, without issuing', async () => {
    const bad: [Partial<StripeSession>, string][] = [
      [{ payment_status: 'unpaid' }, 'not_paid'], [{ status: 'open' }, 'not_paid'],
      [{ payment_link: 'plink_other' }, 'wrong_payment_link'], [{ amount_total: 100 }, 'wrong_amount'],
      [{ currency: 'eur' }, 'wrong_amount'], [{ client_reference_id: 'bad id!' }, 'bad_reference'],
      [{ id: 'cs_test_someoneelse00' }, 'session_mismatch']];
    for (const [o, reason] of bad) {
      sessions[SID] = session(o);
      const r = await call(`/paid?session_id=${SID}`);
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(await r.text()).toContain(reason);
    }
    expect(env.LICENSES.m.size).toBe(0);
    expect((await call('/paid?session_id=cs_test_unknownunknown')).status).toBe(404);
    apiCalls = [];
    expect((await call('/paid?session_id=nope')).status).toBe(400);
    expect((await call('/paid?session_id=cs_test_x%2F..%2Fcharges')).status).toBe(400);
    expect(apiCalls).toHaveLength(0);                           // malformed ids never reach the API
  });

  it('accepts both Adaptive Pricing session shapes', async () => {
    sessions[SID] = session({ presentment_details: { presentment_amount: 3600, presentment_currency: 'cny' } });
    expect((await call(`/paid?session_id=${SID}`)).status).toBe(200);
    env.LICENSES.m.clear();
    sessions[SID] = session({ amount_total: 3600, currency: 'cny', currency_conversion: { amount_total: 499, source_currency: 'usd' } });
    expect((await call(`/paid?session_id=${SID}`)).status).toBe(200);
    env.LICENSES.m.clear();
    sessions[SID] = session({ amount_total: 3600, currency: 'cny', currency_conversion: { amount_total: 100, source_currency: 'usd' } });
    expect((await call(`/paid?session_id=${SID}`)).status).toBe(402);
  });

  it('issues nothing without a restricted key or payment link id; refuses sk_ keys', async () => {
    for (const patch of [{ STRIPE_RESTRICTED_KEY: '' }, { STRIPE_RESTRICTED_KEY: 'sk_live_full' }, { PAYMENT_LINK_ID: '' }]) {
      Object.assign(env, { STRIPE_RESTRICTED_KEY: 'rk_test_readonly', PAYMENT_LINK_ID: LINK }, patch);
      const r = await call(`/paid?session_id=${SID}`);
      expect(r.status).toBe(503);
      expect((await hook(paid)).status).toBe(503);              // webhook too (Stripe retries later)
    }
    expect(env.LICENSES.m.size).toBe(0);
  });

  it('webhook is an optional backup: re-verified via API, same key as /paid, one record', async () => {
    // a signed event claiming "paid" is still checked against the API
    sessions[SID] = session({ payment_status: 'unpaid' });
    expect(await (await hook(paid)).json()).toMatchObject({ ok: false, reason: 'not_paid' });
    expect(env.LICENSES.m.size).toBe(0);
    sessions[SID] = session();
    expect(await (await hook(paid)).json()).toMatchObject({ ok: true, status: 'issued' });
    expect(await (await hook(paid)).json()).toMatchObject({ ok: true, status: 'existing' });
    const key = keyOf();
    expect(key).toBe(await deriveKey(SID, env));
    expect(await (await call(`/paid?session_id=${SID}`)).text()).toContain(key);
    expect([...env.LICENSES.m.keys()].filter((k) => k.startsWith('key:'))).toHaveLength(1);
    delete env.STRIPE_WEBHOOK_SECRET;
    expect((await hook(paid)).status).toBe(503);
  });

  it('activates up to 3 devices with a verifiable 30-day token and CORS', async () => {
    await call(`/paid?session_id=${SID}`);
    const key = keyOf();
    const r = await act(key.toLowerCase(), 'device-0001');
    expect(r.status).toBe(200);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    const { token } = await r.json() as { token: string };
    const p = await verifyToken(token, pub);
    expect(p?.device).toBe('device-0001');
    expect(p!.exp - p!.iat).toBe(30 * 86_400_000);
    expect((await act(key, 'device-0001')).status).toBe(200); // same device again is fine
    expect((await act(key, 'device-0002')).status).toBe(200);
    expect((await act(key, 'device-0003')).status).toBe(200);
    const r4 = await act(key, 'device-0004');
    expect(r4.status).toBe(403);
    expect(await r4.json()).toEqual({ error: 'device-limit' });
    expect((await act(key, 'device-0005', 'https://evil.example')).headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('rejects unknown and malformed keys and revokes on refund', async () => {
    expect((await act('XENG-AAAA-BBBB-CCCC', 'device-0001')).status).toBe(404);
    expect((await act('nope', 'device-0001')).status).toBe(400);
    await call(`/paid?session_id=${SID}`);
    const key = keyOf();
    await hook({ type: 'charge.refunded', data: { object: { id: 'ch_1', payment_intent: 'pi_1' } } });
    expect((JSON.parse(env.LICENSES.m.get(`key:${key}`)!) as LicenseRecord).status).toBe('revoked');
    expect(await (await act(key, 'device-0001')).json()).toEqual({ error: 'revoked' });
    expect((await call(`/paid?session_id=${SID}`)).status).toBe(410);   // refunded: key not re-shown
  });

  it('other routes', async () => {
    expect((await call('/nothing')).status).toBe(404);
    expect(await (await call('/')).json()).toEqual({ service: 'xeng-license', health: '/health' });
    expect(await (await call('/health')).json()).toEqual({ ok: true, payments_configured: true, admin_enabled: false, revoked_refs: false });
    env.STRIPE_RESTRICTED_KEY = '';
    expect(await (await call('/health')).json()).toMatchObject({ payments_configured: false });
    expect((await call('/activate', { method: 'OPTIONS', headers: { Origin: ORIGIN } })).status).toBe(204);
  });
});

const ADMIN = 'f'.repeat(16) + '0123456789abcdef0123456789abcdef';
const WX = { by: 'cashier-li', reason: 'WeChat Pay ¥29 confirmed', channel: 'wechat', amount: 29, currency: 'CNY',
             ref: '4200001234202610220001', install: INSTALL };
const admin = (path: string, body: unknown, token: string | null = ADMIN, ip = '1.2.3.4') =>
  call(path, { method: 'POST', body: JSON.stringify(body),
               headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...(token === null ? {} : { Authorization: `Bearer ${token}` }) } });
const logEntries = () => [...env.LICENSES.m.entries()].filter(([k]) => k.startsWith('adminlog:')).map(([, v]) => JSON.parse(v));

describe('admin (manual WeChat payments)', () => {
  beforeEach(() => { env.ADMIN_TOKEN = ADMIN; });

  it('is disabled without a token or with a short one', async () => {
    for (const t of [undefined, 'short-token-123']) {
      env.ADMIN_TOKEN = t;
      expect((await admin('/admin/issue', WX, t ?? 'x')).status).toBe(404);
    }
    expect([...env.LICENSES.m.keys()].some((k) => k.startsWith('key:'))).toBe(false);
  });

  it('issues one key per channel+ref (idempotent), activatable, logged without the token', async () => {
    const r1 = await admin('/admin/issue', WX);
    expect(r1.status).toBe(200);
    const { key, result } = await r1.json() as { key: string; result: string };
    expect(result).toBe('issued');
    expect(key).toMatch(/^XENG-/);
    const r2 = await (await admin('/admin/issue', { ...WX, reason: 'sent twice by mistake' })).json() as { key: string; result: string };
    expect(r2).toEqual({ result: 'existing', key });
    expect([...env.LICENSES.m.keys()].filter((k) => k.startsWith('key:'))).toHaveLength(1);
    const other = await (await admin('/admin/issue', { ...WX, ref: 'another-ref-0002' })).json() as { key: string };
    expect(other.key).not.toBe(key);
    const rec = JSON.parse(env.LICENSES.m.get(`key:${key}`)!) as LicenseRecord;
    expect(rec).toMatchObject({ status: 'active', source: 'admin', ref: INSTALL, manual: { channel: 'wechat', amount: 29, currency: 'CNY', ref: WX.ref, by: 'cashier-li' } });
    expect((await act(key, 'device-0001')).status).toBe(200);
    const log = logEntries();
    expect(log.map((e) => e.result)).toEqual(['issued', 'existing', 'issued']);
    for (const e of log) for (const f of ['ts', 'action', 'by', 'reason', 'channel', 'amount', 'currency', 'ref', 'source']) expect(e).toHaveProperty(f);
    expect(JSON.stringify([...env.LICENSES.m.entries()])).not.toContain(ADMIN);
    const list = await (await call('/admin/log?limit=2', { headers: { Authorization: `Bearer ${ADMIN}` } })).json() as { entries: unknown[] };
    expect(list.entries).toHaveLength(2);
  });

  it('revokes idempotently and logs it', async () => {
    const { key } = await (await admin('/admin/issue', WX)).json() as { key: string };
    expect(await (await admin('/admin/revoke', { key, by: 'owner', reason: 'refunded' })).json())
      .toEqual({ result: 'revoked', add_to_REVOKED_REFS: `wechat:${WX.ref}` });
    expect(await (await admin('/admin/revoke', { key, by: 'owner', reason: 'again' })).json()).toMatchObject({ result: 'already_revoked' });
    expect((await admin('/admin/revoke', { key: 'XENG-AAAA-BBBB-CCCC', by: 'y', reason: 'x' })).status).toBe(404);
    expect(await (await act(key, 'device-0001')).json()).toEqual({ error: 'revoked' });
    expect(logEntries().filter((e) => e.action === 'revoke').map((e) => e.result)).toEqual(['revoked', 'already_revoked', 'not_found']);
    // a refunded WeChat ref still maps to the same (revoked) key: re-issuing doesn't mint a new one
    expect(await (await admin('/admin/issue', WX)).json()).toEqual({ result: 'existing', key });
  });

  it('validates input', async () => {
    for (const patch of [{ by: '' }, { reason: '' }, { ref: '' }, { ref: 'has space' }, { channel: 'cash?' },
                         { amount: 'lots' }, { currency: 'XYZ' }, { reason: 'a\nb' }, { install: 'bad id!' }])
      expect((await admin('/admin/issue', { ...WX, ...patch })).status).toBe(400);
    expect((await admin('/admin/revoke', { key: 'nope', by: 'y', reason: 'x' })).status).toBe(400);
    expect([...env.LICENSES.m.keys()].some((k) => k.startsWith('key:'))).toBe(false);
  });

  it('locks out after failed attempts (per IP and global), even for the right token', async () => {
    expect((await admin('/admin/issue', WX, null)).status).toBe(401);
    for (let i = 0; i < 4; i++) expect((await admin('/admin/issue', WX, 'g'.repeat(48))).status).toBe(401);
    expect((await admin('/admin/issue', WX)).status).toBe(429);
    expect((await admin('/admin/issue', WX, ADMIN, '5.6.7.8')).status).toBe(200);   // other IP still fine
    for (let i = 0; i < 20; i++) await admin('/admin/issue', WX, 'g'.repeat(48), `9.9.9.${i}`);
    expect((await admin('/admin/issue', WX, ADMIN, '7.7.7.7')).status).toBe(429);   // global lock
    expect(JSON.stringify([...env.LICENSES.m.entries()])).not.toContain('g'.repeat(48));
  });

  it('broader read-only rk_ key works; sk_/pk_ refused', async () => {
    env.STRIPE_RESTRICTED_KEY = 'rk_live_checkout_charges_balance_read';
    expect((await call(`/paid?session_id=${SID}`)).status).toBe(200);
    expect(apiCalls.map((c) => c.url)).toEqual([`https://api.stripe.com/v1/checkout/sessions/${SID}`,
                                                'https://api.stripe.com/v1/charges?payment_intent=pi_1&limit=10']);
    env.LICENSES.m.clear();
    for (const k of ['sk_live_full', 'pk_live_pub']) {
      env.STRIPE_RESTRICTED_KEY = k;
      expect((await call(`/paid?session_id=${SID}`)).status).toBe(503);
    }
  });
});

describe('admin audit lines', () => {
  it('console.logs ADMIN_AUDIT JSON per action without secrets', async () => {
    env.ADMIN_TOKEN = ADMIN;
    env.STRIPE_RESTRICTED_KEY = 'rk_live_secret_should_not_leak';
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { key } = await (await admin('/admin/issue', { ...WX, reason: 'pasted ' + ADMIN })).json() as { key: string };
      await admin('/admin/revoke', { key, by: 'y', reason: 'refund' });
      await admin('/admin/issue', WX, 'h'.repeat(48));
      const lines = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('ADMIN_AUDIT '));
      expect(lines).toHaveLength(3);
      const recs = lines.map((l) => JSON.parse(l.slice('ADMIN_AUDIT '.length)));
      expect(recs.map((r) => r.result ?? r.event)).toEqual(['issued', 'revoked', 'admin_auth_failed']);
      expect(recs[0]).toMatchObject({ action: 'issue', ref: WX.ref, channel: 'wechat', amount: 29 });
      const all = lines.join('\n');
      for (const secret of [ADMIN, 'rk_live_secret_should_not_leak', 'h'.repeat(48)]) expect(all).not.toContain(secret);
    } finally { spy.mockRestore(); }
  });
});

describe('admin CLI', () => {
  it('sends the bearer token and never prints it', async () => {
    // @ts-expect-error plain .mjs script
    const { main } = await import('../../scripts/admin.mjs');
    const calls: { url: string; init: RequestInit }[] = [];
    const lines: string[] = [];
    const out = { log: (s: string) => lines.push(s), error: (s: string) => lines.push(s) };
    const f = async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('{"result":"issued"}'); };
    const code = await main(['issue', '--url', 'https://license.test/', '--by', 'y', '--reason', 'r', '--ref', 'wx1', '--amount', '29'],
                            f, { ADMIN_TOKEN: ADMIN }, out);
    expect(code).toBe(0);
    expect(calls[0].url).toBe('https://license.test/admin/issue');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ADMIN}`);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ channel: 'comp', ref: 'wx1', source: 'cli' });
    expect(lines.join()).not.toContain(ADMIN);
    expect(await main(['issue', '--url', 'x', '--by', 'y', '--reason', 'r'], f, { ADMIN_TOKEN: 'short' }, out)).toBe(2);
  });

  it('builds REVOKED_REFS from an exported Render log', async () => {
    // @ts-expect-error plain .mjs script
    const { revokedRefsFromLog } = await import('../../scripts/admin.mjs');
    const log = [
      '2026-10-22T05:00:00Z ADMIN_AUDIT {"event":"admin","action":"revoke","key":"XENG-AAAA-BBBB-CCCC-DDDD","result":"revoked","durable":"wechat:wx1"}',
      'ADMIN_AUDIT {"event":"admin","action":"revoke","key":"XENG-ZZZZ-ZZZZ-ZZZZ","result":"not_found"}',
      'ADMIN_AUDIT {"event":"store_put","k":"key:XENG-EEEE-FFFF-GGGG","v":{"status":"revoked","session":"cs_test_refunded00001"}}',
      'ADMIN_AUDIT {"event":"store_put","k":"key:XENG-HHHH-JJJJ-KKKK","v":{"status":"active","session":"cs_test_ok0000000001"}}',
      'noise', 'ADMIN_AUDIT {broken'].join('\n');
    expect(revokedRefsFromLog(log)).toBe('cs_test_refunded00001,wechat:wx1');
  });
});

describe('store wipe (Render free restarts)', () => {
  const wipe = () => { env.LICENSES = new MemKV(); _resetRecovery(); };
  const rec = (key: string) => JSON.parse(env.LICENSES.m.get(`key:${key}`)!) as LicenseRecord;

  it('/paid re-issues the same Stripe key after a wipe', async () => {
    await call(`/paid?session_id=${SID}`);
    const key = keyOf();
    wipe();
    const r = await call(`/paid?session_id=${SID}`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain(key);
    expect(keyOf()).toBe(key);
  });

  it('/activate rebuilds an unknown Stripe key from the Payment Link session list (throttled)', async () => {
    await call(`/paid?session_id=${SID}`);
    const key = keyOf();
    expect((await act(key, 'device-0001')).status).toBe(200);
    wipe(); apiCalls = [];
    const r = await act(key, 'device-0001');
    expect(r.status).toBe(200);
    expect(rec(key)).toMatchObject({ status: 'active', session: SID, paymentIntent: 'pi_1', recovered: true,
                                     refundCheck: { status: 'ok' }, devices: ['device-0001'] });
    expect(apiCalls[0].url).toBe(`https://api.stripe.com/v1/checkout/sessions?payment_link=${LINK}&status=complete&limit=100`);
    // an unknown key right after: no second Stripe scan within 30 s
    apiCalls = [];
    expect((await act('XENG-AAAA-BBBB-CCCC', 'device-0001')).status).toBe(404);
    expect(apiCalls).toHaveLength(0);
    // sessions failing verification (other link / amount) never yield keys
    wipe();
    sessions = { cs_test_wrongamount000: session({ id: 'cs_test_wrongamount000', amount_total: 100 }) };
    expect((await act(await deriveKey('cs_test_wrongamount000', env), 'device-0001')).status).toBe(404);
  });

  it('a refund revokes the key even when the store was wiped (Charges: Read)', async () => {
    await call(`/paid?session_id=${SID}`);
    const key = keyOf();
    wipe();
    charges.pi_1 = [charge({ amount_refunded: 499, refunded: true })];
    expect(await (await act(key, 'device-0001')).json()).toEqual({ error: 'revoked' });
    expect(rec(key)).toMatchObject({ status: 'revoked', revokedBy: 'stripe', refundCheck: { status: 'refunded' } });
    wipe();
    expect((await call(`/paid?session_id=${SID}`)).status).toBe(410);
  });

  it('partial refunds keep the key; refunds are re-checked at most daily', async () => {
    charges.pi_1 = [charge({ amount_refunded: 100 })];
    await call(`/paid?session_id=${SID}`);
    const key = keyOf();
    expect((await act(key, 'device-0001')).status).toBe(200);
    charges.pi_1 = [charge({ amount_refunded: 499, refunded: true })];
    apiCalls = [];
    expect((await act(key, 'device-0001')).status).toBe(200);           // checked < 24 h ago: cached
    expect(apiCalls).toHaveLength(0);
    env.LICENSES.m.set(`key:${key}`, JSON.stringify({ ...rec(key), refundCheck: { at: Date.now() - 25 * 3_600_000, status: 'ok' } }));
    expect((await act(key, 'device-0001')).status).toBe(403);
  });

  it('degrades gracefully when the key lacks Charges: Read', async () => {
    chargesStatus = 403;
    await call(`/paid?session_id=${SID}`);
    const key = keyOf();
    wipe();
    expect((await act(key, 'device-0001')).status).toBe(200);
    expect(rec(key).refundCheck?.status).toBe('unavailable');
  });

  it('admin (WeChat) keys are self-verifying: valid after a wipe, forgeries rejected', async () => {
    env.ADMIN_TOKEN = ADMIN;
    const { key } = await (await admin('/admin/issue', WX)).json() as { key: string };
    expect(key).toMatch(/^XENG(-[A-Z2-9]{4}){4}$/);
    expect(key).toBe(await deriveAdminKey('wechat', WX.ref, env));
    expect(await isAdminKey(key, env)).toBe(true);
    wipe();
    expect((await act(key, 'device-0001')).status).toBe(200);
    expect(rec(key)).toMatchObject({ status: 'active', source: 'admin', recovered: true });
    const forged = key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A');
    expect((await act(forged, 'device-0001')).status).toBe(404);
    expect((await act('XENG-AAAA-BBBB-CCCC-DDDD', 'device-0001')).status).toBe(404);
    // re-issuing the same ref after a wipe gives the same key
    expect(await (await admin('/admin/issue', WX)).json()).toMatchObject({ key });
  });

  it('REVOKED_REFS revocations survive wipes (channel:ref, session, payment intent, key)', async () => {
    env.ADMIN_TOKEN = ADMIN;
    const { key: wx } = await (await admin('/admin/issue', WX)).json() as { key: string };
    await call(`/paid?session_id=${SID}`);
    const card = keyOf();
    for (const refs of [`wechat:${WX.ref}, ${SID}`, `${wx} pi_1`]) {
      wipe();
      env.REVOKED_REFS = refs;
      expect((await act(wx, 'device-0001')).status).toBe(403);
      expect((await act(card, 'device-0001')).status).toBe(403);
      expect((await call(`/paid?session_id=${SID}`)).status).toBe(410);
    }
    env.REVOKED_REFS = 'cs_test_unrelatedsession0';
    wipe();
    expect((await act(wx, 'device-0001')).status).toBe(200);
    expect(await (await call('/health')).json()).toMatchObject({ revoked_refs: true });
  });

  it('revoking a wiped key records it and says what to add to REVOKED_REFS', async () => {
    env.ADMIN_TOKEN = ADMIN;
    await call(`/paid?session_id=${SID}`);
    const card = keyOf();
    wipe();
    expect(await (await admin('/admin/revoke', { key: card, by: 'owner', reason: 'chargeback' })).json())
      .toEqual({ result: 'revoked', add_to_REVOKED_REFS: card });
    expect((await act(card, 'device-0001')).status).toBe(403);
  });
});
