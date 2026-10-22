// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
// @ts-expect-error plain .mjs module
import { createServer, envFromProcess, FileKV } from '../../server/node-server.mjs';

const ADMIN = 'e'.repeat(16) + '0123456789abcdef0123456789abcdef';

describe('Node license server (Render)', () => {
  it('serves the Worker handler with a persistent JSON store and ADMIN_AUDIT lines', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xeng-'));
    const path = join(dir, 'licenses.json');
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const jwk = JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey));
    const env = envFromProcess(new FileKV(path), { ADMIN_TOKEN: ADMIN, LICENSE_PRIVATE_JWK: jwk, STRIPE_RESTRICTED_KEY: '' });
    expect(env.STRIPE_RESTRICTED_KEY).toBeUndefined();          // empty env vars are not passed through
    const srv = createServer(env);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((s: string) => { logs.push(String(s)); });
    try {
      expect((await fetch(base + '/health')).status).toBe(200);
      expect((await fetch(base + '/admin/issue', { method: 'POST', body: '{}' })).status).toBe(401);
      expect((await fetch(base + '/paid?session_id=cs_test_fakefakefake1234')).status).toBe(503);   // no key -> locked
      const r = await fetch(base + '/admin/issue', { method: 'POST', headers: { Authorization: `Bearer ${ADMIN}`, 'X-Forwarded-For': '1.2.3.4' },
        body: JSON.stringify({ by: 'owner', reason: 'test', ref: 'wx-ref-1', amount: 29 }) });
      const { key } = await r.json() as { key: string };
      expect(key).toMatch(/^XENG-/);
      const stored = JSON.parse(readFileSync(path, 'utf8'));
      expect(Object.keys(stored).some((k) => k === `key:${key}`)).toBe(true);
      expect(new FileKV(path).m.has(`key:${key}`)).toBe(true);    // survives a process restart (same disk)
      const audit = logs.filter((l) => l.startsWith('ADMIN_AUDIT '));
      expect(audit.some((l) => l.includes('"event":"store_put"') && l.includes(key))).toBe(true);
      expect(logs.join('\n')).not.toContain(ADMIN);
      expect(logs.join('\n')).not.toContain(JSON.parse(jwk).d);
    } finally { spy.mockRestore(); srv.close(); }
  });

  it('an admin key keeps working after the store file is deleted (Render restart)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xeng-'));
    const path = join(dir, 'licenses.json');
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const proc = { ADMIN_TOKEN: ADMIN, LICENSE_PRIVATE_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey)) };
    const start = async () => {
      const srv = createServer(envFromProcess(new FileKV(path), proc));
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
      return { srv, base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` };
    };
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let a = await start();
    try {
      const { key } = await (await fetch(a.base + '/admin/issue', { method: 'POST', headers: { Authorization: `Bearer ${ADMIN}` },
        body: JSON.stringify({ by: 'owner', reason: 'test', ref: 'wx-ref-2' }) })).json() as { key: string };
      a.srv.close();
      rmSync(dir, { recursive: true, force: true });               // what a Render free restart does
      a = await start();
      const r = await fetch(a.base + '/activate', { method: 'POST', body: JSON.stringify({ key, device: 'device-0001' }) });
      expect(r.status).toBe(200);
      expect(((await r.json()) as { token: string }).token).toBeTruthy();
      expect((await fetch(a.base + '/')).status).toBe(200);
    } finally { spy.mockRestore(); a.srv.close(); }
  });

  it('FileKV honours expirationTtl', async () => {
    const kv = new FileKV('');
    await kv.put('adminfail:all', '3', { expirationTtl: 60 });
    expect(await kv.get('adminfail:all')).toBe('3');
    kv.m.get('adminfail:all').exp = Date.now() - 1;
    expect(await kv.get('adminfail:all')).toBeNull();
  });
});
