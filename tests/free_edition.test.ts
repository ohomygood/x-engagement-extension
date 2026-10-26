// @vitest-environment node
// Free Chrome Web Store edition ("non-trader" account): the shipped bundles contain no purchase entry, payment link,
// license/unlock flow, price or paid-tier copy, and make no network requests.
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

describe('free store edition', () => {
  it('bundles without any paid, license, payment or dev-host text', async () => {
    // @ts-expect-error plain .mjs script
    const { FREE_BAD } = await import('../scripts/check_release.mjs');
    const r = await build({ entryPoints: ['src/content.ts', 'src/background.ts', 'src/dashboard.ts'], bundle: true, write: false,
                            format: 'iife', target: 'chrome114', outdir: 'out', minify: true, legalComments: 'none' });
    for (const f of r.outputFiles) {
      expect(f.text.match(FREE_BAD)?.[0], f.path).toBeUndefined();
      expect(f.text, f.path).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket/);
    }
    const { readFileSync } = await import('node:fs');
    for (const f of ['static/dashboard.html', 'static/dashboard.css', 'static/_locales/en/messages.json', 'static/_locales/zh_CN/messages.json'])
      expect(readFileSync(f, 'utf8').match(FREE_BAD)?.[0], f).toBeUndefined();
  });
  it('flags paid copy in a build dir', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    // @ts-expect-error plain .mjs script
    const { checkFreeEdition } = await import('../scripts/check_release.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'free-'));
    writeFileSync(join(dir, 'ok.js'), 'indexedDB.open("x",1).onupgradeneeded=()=>{}');
    expect(checkFreeEdition(dir)).toEqual([]);
    writeFileSync(join(dir, 'bad.js'), 'const u="https://buy.stripe.com/x"');
    expect(checkFreeEdition(dir).join('\n')).toContain('bad.js');
  });
});
