#!/usr/bin/env node
// Cashier CLI for the license Worker (docs/manual_unlock.md). Reads ADMIN_TOKEN from env; never prints it.
//   node scripts/admin.mjs issue  --url <LICENSE_URL> --by owner --reason "comp for reviewer" --ref comp-2026-001 [--channel comp --install <install id>]
//   node scripts/admin.mjs revoke --url <LICENSE_URL> --by owner --reason "refunded" --key XENG-XXXX-XXXX-XXXX [--ref <txn>]
//   node scripts/admin.mjs log    --url <LICENSE_URL> [--limit 50]
//   node scripts/admin.mjs revoked-refs --from <exported Render log>   → value for env REVOKED_REFS (no token needed)
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

/** REVOKED_REFS value from `ADMIN_AUDIT {json}` lines: every revocation (and Stripe refund revocation) ever logged. */
export function revokedRefsFromLog(text) {
  const out = new Set();
  for (const line of String(text).split('\n')) {
    const i = line.indexOf('ADMIN_AUDIT {');
    if (i < 0) continue;
    let r; try { r = JSON.parse(line.slice(i + 'ADMIN_AUDIT '.length)); } catch { continue; }
    if (r.action === 'revoke' && ['revoked', 'already_revoked'].includes(r.result)) out.add(r.durable || r.key);
    if (r.event === 'store_put' && r.v && r.v.status === 'revoked' && typeof r.k === 'string' && r.k.startsWith('key:'))
      out.add(r.v.manual ? `${r.v.manual.channel}:${r.v.manual.ref}` : (r.v.session && r.v.session.startsWith('cs_') ? r.v.session : r.k.slice(4)));
  }
  return [...out].filter(Boolean).sort().join(',');
}

export async function main(argv = process.argv.slice(2), fetchImpl = fetch, env = process.env, out = console) {
  const [cmd, ...rest] = argv;
  const { values: v } = parseArgs({ args: rest, options: {
    url: { type: 'string' }, by: { type: 'string' }, reason: { type: 'string' }, ref: { type: 'string' },
    channel: { type: 'string', default: 'comp' }, amount: { type: 'string' }, currency: { type: 'string' },
    install: { type: 'string' }, key: { type: 'string' }, limit: { type: 'string', default: '50' }, from: { type: 'string' } } });
  if (cmd === 'revoked-refs') {
    if (!v.from) { out.error('--from <log file> is required'); return 2; }
    out.log(revokedRefsFromLog(readFileSync(v.from, 'utf8')));
    return 0;
  }
  const token = env.ADMIN_TOKEN || '';
  if (!['issue', 'revoke', 'log'].includes(cmd)) { out.error('usage: admin.mjs issue|revoke|log --url <LICENSE_URL> … | revoked-refs --from <log>'); return 2; }
  if (token.length < 32) { out.error('ADMIN_TOKEN env var missing or shorter than 32 chars'); return 2; }
  if (!v.url) { out.error('--url <LICENSE_URL> is required'); return 2; }
  const base = v.url.replace(/\/+$/, '');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  let r;
  if (cmd === 'log') {
    r = await fetchImpl(`${base}/admin/log?limit=${encodeURIComponent(v.limit)}`, { headers });
  } else {
    if (!v.by || !v.reason) { out.error('--by and --reason are required'); return 2; }
    const body = cmd === 'issue'
      ? { by: v.by, reason: v.reason, ref: v.ref, channel: v.channel, amount: v.amount, currency: v.currency, install: v.install, source: 'cli' }
      : { by: v.by, reason: v.reason, key: v.key, ref: v.ref, source: 'cli' };
    r = await fetchImpl(`${base}/admin/${cmd}`, { method: 'POST', headers, body: JSON.stringify(body) });
  }
  out.log(await r.text());
  return r.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await main());
