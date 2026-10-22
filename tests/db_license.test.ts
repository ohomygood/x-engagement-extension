import 'fake-indexeddb/auto';
import { _resetForTests, accounts, addSnapshot, getMeta, getSnapshots, getTweets, putTweets, rememberAccount, setMeta, wipeAccount } from '../src/db';
import { activate, signToken, verifyToken, type LicensePayload } from '../src/license';
import { validMsg } from '../src/messages';
import type { TweetRecord } from '../src/types';

const tw = (id: string, extra: Partial<TweetRecord> = {}): TweetRecord =>
  ({ id, account: 'me', author: 'alice', name: 'A', text: 't', time: 1, replyTo: ['me'], url: 'u', seenAt: 1, ...extra });

describe('IndexedDB store', () => {
  beforeEach(async () => { await _resetForTests(); });

  it('upserts tweets without losing inferred parent info', async () => {
    expect(await putTweets([tw('1', { parentId: '100', convoId: '100' }), tw('2')])).toBe(2);
    expect(await putTweets([tw('1', { replyTo: [], text: 'edited' })])).toBe(0);
    const t1 = (await getTweets('me')).find((t) => t.id === '1')!;
    expect(t1.parentId).toBe('100');
    expect(t1.replyTo).toEqual(['me']);
    expect(t1.text).toBe('edited');
  });

  it('keeps accounts separate and wipes one account', async () => {
    await putTweets([tw('1'), tw('1', { account: 'other' })]);
    await addSnapshot({ account: 'me', kind: 'followers', takenAt: 1, complete: true, users: [] });
    await rememberAccount('me'); await rememberAccount('other');
    await wipeAccount('me');
    expect(await getTweets('me')).toHaveLength(0);
    expect(await getSnapshots('me')).toHaveLength(0);
    expect(await getTweets('other')).toHaveLength(1);
    expect(await accounts()).toEqual(['other']);
  });

  it('stores 1,000 tweets in one batch quickly', async () => {
    const t0 = performance.now();
    await putTweets(Array.from({ length: 1000 }, (_, i) => tw(String(i))));
    expect(await getTweets('me')).toHaveLength(1000);
    expect(performance.now() - t0).toBeLessThan(5000);
  });

  it('meta round-trips', async () => {
    await setMeta('k', { a: 1 });
    expect(await getMeta('k')).toEqual({ a: 1 });
  });
});

describe('license tokens', () => {
  async function keys() {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    return { pub: await crypto.subtle.exportKey('jwk', kp.publicKey), priv: await crypto.subtle.exportKey('jwk', kp.privateKey) };
  }
  const payload = (exp: number): LicensePayload => ({ key: 'XENG-AAAA-BBBB-CCCC', plan: 'pro', device: 'd1', iat: 1, exp });

  it('verifies a valid token and rejects tampering, expiry and other keys', async () => {
    const { pub, priv } = await keys();
    const tok = await signToken(payload(Date.now() + 1e6), priv);
    expect((await verifyToken(tok, pub))?.key).toBe('XENG-AAAA-BBBB-CCCC');
    const [p, s] = tok.split('.');
    const forged = btoa(JSON.stringify({ ...payload(Date.now() + 1e9), key: 'XENG-ZZZZ-ZZZZ-ZZZZ' })).replace(/=+$/, '');
    expect(await verifyToken(`${forged}.${s}`, pub)).toBeNull();
    expect(await verifyToken(await signToken(payload(Date.now() - 1), priv), pub)).toBeNull();
    expect(await verifyToken(tok, (await keys()).pub)).toBeNull();
    expect(await verifyToken('garbage', pub)).toBeNull();
    expect(p.length).toBeGreaterThan(10);
  });

  it('activate() validates format and handles server errors', async () => {
    expect(await activate('https://x', 'nope', 'd')).toEqual({ error: 'invalid-key-format' });
    const ok = (async () => new Response(JSON.stringify({ token: 'T' }), { status: 200 })) as unknown as typeof fetch;
    expect(await activate('https://x', 'xeng-aaaa-bbbb-cccc', 'd', ok)).toEqual({ token: 'T' });
    const bad = (async () => new Response(JSON.stringify({ error: 'unknown-key' }), { status: 404 })) as unknown as typeof fetch;
    expect(await activate('https://x', 'XENG-AAAA-BBBB-CCCC', 'd', bad)).toEqual({ error: 'unknown-key' });
    const down = (async () => { throw new Error('x'); }) as unknown as typeof fetch;
    expect(await activate('https://x', 'XENG-AAAA-BBBB-CCCC', 'd', down)).toEqual({ error: 'network' });
  });
});

describe('message validation', () => {
  it('accepts well-formed and rejects malformed messages', () => {
    expect(validMsg({ type: 'tweets', account: 'me', tweets: [tw('1')] })).toBe(true);
    expect(validMsg({ type: 'tweets', account: 'me', tweets: [tw('x1')] })).toBe(false);
    expect(validMsg({ type: 'tweets', account: 'me', tweets: [tw('1', { account: 'evil' })] })).toBe(false);
    expect(validMsg({ type: 'snapshot', snapshot: { account: 'me', kind: 'followers', users: [{ handle: 'a b' }] } })).toBe(false);
    expect(validMsg({ type: 'other' })).toBe(false);
  });
});

describe('token refresh', () => {
  beforeEach(async () => { await _resetForTests(); });
  it('renews only near expiry, at most once a day', async () => {
    const { refreshIfNeeded } = await import('../src/plan');
    const DAY = 86_400_000, now = Date.now();
    let calls = 0;
    const f = (async () => { calls++; return new Response(JSON.stringify({ token: 'NEW' }), { status: 200 }); }) as unknown as typeof fetch;
    expect(await refreshIfNeeded(now, f)).toBe('skipped'); // never activated
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const priv = await crypto.subtle.exportKey('jwk', kp.privateKey);
    await setMeta('licenseKey', 'XENG-AAAA-BBBB-CCCC'); await setMeta('deviceId', 'device-0001');
    await setMeta('licenseToken', await signToken({ key: 'XENG-AAAA-BBBB-CCCC', plan: 'pro', device: 'd', iat: now, exp: now + 20 * DAY }, priv));
    expect(await refreshIfNeeded(now, f)).toBe('skipped'); // 20 days left
    await setMeta('licenseToken', await signToken({ key: 'XENG-AAAA-BBBB-CCCC', plan: 'pro', device: 'd', iat: now, exp: now + 2 * DAY }, priv));
    expect(await refreshIfNeeded(now, f)).toBe('renewed');
    expect(await getMeta('licenseToken')).toBe('NEW');
    await setMeta('licenseToken', 'x.y');
    expect(await refreshIfNeeded(now + 3600_000, f)).toBe('skipped'); // tried < 24h ago
    expect(calls).toBe(1);
  });
});
