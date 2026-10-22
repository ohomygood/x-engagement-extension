#!/usr/bin/env node
// Cashier CLI for the license Worker (docs/manual_unlock.md). Reads ADMIN_TOKEN from env; never prints it.
//   node scripts/admin.mjs issue  --url <LICENSE_URL> --by owner --reason "WeChat ¥29 confirmed" --ref <txn> [--channel wechat --amount 29 --currency CNY --install <install id>]
//   node scripts/admin.mjs revoke --url <LICENSE_URL> --by owner --reason "refunded" --key XENG-XXXX-XXXX-XXXX [--ref <txn>]
//   node scripts/admin.mjs log    --url <LICENSE_URL> [--limit 50]
import { parseArgs } from 'node:util';

export async function main(argv = process.argv.slice(2), fetchImpl = fetch, env = process.env, out = console) {
  const [cmd, ...rest] = argv;
  const { values: v } = parseArgs({ args: rest, options: {
    url: { type: 'string' }, by: { type: 'string' }, reason: { type: 'string' }, ref: { type: 'string' },
    channel: { type: 'string', default: 'wechat' }, amount: { type: 'string' }, currency: { type: 'string' },
    install: { type: 'string' }, key: { type: 'string' }, limit: { type: 'string', default: '50' } } });
  const token = env.ADMIN_TOKEN || '';
  if (!['issue', 'revoke', 'log'].includes(cmd)) { out.error('usage: admin.mjs issue|revoke|log --url <LICENSE_URL> …'); return 2; }
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
