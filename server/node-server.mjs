// License server on Node (Render free web service). Runs the SAME handler as the Cloudflare Worker
// (worker/src/index.ts), with a small JSON-file KV in place of Workers KV.
//
// PERSISTENCE CAVEAT (Render free): the disk is ephemeral; every restart/redeploy/spin-down wipes the store.
//  * Every write of a license record is ALSO printed as `ADMIN_AUDIT {json}` on stdout (Render logs), so
//    issued keys, refs and revocations survive in the log stream.
//  * No key needs the store to stay valid (worker/src/index.ts header): Stripe keys are re-derived from the
//    session (/paid) or found again by listing our Payment Link's sessions (/activate); admin (WeChat) keys are
//    self-verifying. Refunds are re-checked in Stripe (Charges: Read). Activated tokens verify offline for 30 days.
//  * Manual revocations and device lists are lost on a wipe: put revocations in env REVOKED_REFS (durable).
import http from 'node:http';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import worker from '../worker/src/index.ts';

const LOGGED = /^(key|session|adminref|pi):/;

export class FileKV {
  constructor(path) {
    this.path = path;
    this.m = new Map();
    if (path) {
      try { for (const [k, v] of Object.entries(JSON.parse(readFileSync(path, 'utf8')))) this.m.set(k, v); } catch { /* fresh */ }
    }
  }
  _live(k) {
    const e = this.m.get(k);
    if (!e) return undefined;
    if (e.exp && e.exp < Date.now()) { this.m.delete(k); return undefined; }
    return e;
  }
  async get(k, type) {
    const e = this._live(k);
    if (!e) return null;
    return type === 'json' ? JSON.parse(e.v) : e.v;
  }
  async put(k, v, opts = {}) {
    const ttl = opts.expirationTtl ? Number(opts.expirationTtl) : 0;
    this.m.set(k, { v: String(v), exp: ttl ? Date.now() + ttl * 1000 : 0 });
    if (LOGGED.test(k)) {
      let val; try { val = JSON.parse(v); } catch { val = String(v); }
      console.log('ADMIN_AUDIT ' + JSON.stringify({ ts: new Date().toISOString(), event: 'store_put', k, v: val }));
    }
    this._save();
  }
  async delete(k) { this.m.delete(k); this._save(); }
  async list({ prefix = '', limit = 1000 } = {}) {
    const keys = [...this.m.keys()].filter((k) => k.startsWith(prefix) && this._live(k)).sort().slice(0, limit);
    return { keys: keys.map((name) => ({ name })), list_complete: true };
  }
  _save() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + '.tmp';
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.m)), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

export function envFromProcess(kv, e = process.env) {
  const pick = ['STRIPE_RESTRICTED_KEY', 'PAYMENT_LINK_ID', 'EXPECTED_AMOUNT', 'EXPECTED_CURRENCY', 'STRIPE_WEBHOOK_SECRET',
                'LICENSE_PRIVATE_JWK', 'ALLOWED_ORIGINS', 'MAX_DEVICES', 'ADMIN_TOKEN', 'REVOKED_REFS'];
  const env = { LICENSES: kv };
  for (const k of pick) if (e[k] !== undefined && e[k] !== '') env[k] = e[k];
  return env;
}

export function createServer(env, { trustProxy = true } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 1_000_000) { res.writeHead(413).end(); return; } chunks.push(c); }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      // The Worker reads CF-Connecting-IP for admin lockouts: never trust a client-sent one; derive it from the proxy.
      headers.delete('cf-connecting-ip');
      const ip = (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
      headers.set('CF-Connecting-IP', ip.slice(0, 64));
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
      const request = new Request(`http://localhost${req.url}`, { method: req.method, headers, body });
      const r = await worker.fetch(request, env);
      const out = Buffer.from(await r.arrayBuffer());
      const h = {}; r.headers.forEach((v, k) => { h[k] = v; });
      h['x-content-type-options'] = 'nosniff';
      res.writeHead(r.status, h).end(out);
    } catch (err) {
      console.error('request failed:', err && err.name);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"internal"}');
    }
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const kv = new FileKV(process.env.LICENSE_STORE_PATH || './data/licenses.json');
  const env = envFromProcess(kv);
  if (!env.LICENSE_PRIVATE_JWK) console.warn('LICENSE_PRIVATE_JWK not set: /activate and key issuance will fail');
  const port = Number(process.env.PORT || 8788);
  createServer(env).listen(port, '0.0.0.0', () => console.log(`xeng license server on :${port} (store ${kv.path}; ephemeral on Render free)`));
}
