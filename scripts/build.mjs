// Build: esbuild bundles each entry as an IIFE (MV3 content scripts can't be ES modules), then copies static assets.
// `--e2e` adds http://localhost/* to content-script matches so the E2E suite can run against local fixtures.
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const e2e = process.argv.includes('--e2e');
const out = e2e ? 'dist-e2e' : 'dist';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: { content: 'src/content.ts', background: 'src/background.ts', dashboard: 'src/dashboard.ts' },
  bundle: true, format: 'iife', target: 'chrome114', outdir: out, minify: !e2e, sourcemap: false, legalComments: 'none',
});
// Allowlist: only the dashboard page, its CSS, locales and the three icons ship. No other image (and never a payment QR)
// can end up in a build, even if one is dropped into static/.
const ALLOWED = /^static(\/(dashboard\.(html|css)|_locales(\/[a-z_A-Z]+(\/messages\.json)?)?|icons(\/icon(16|48|128)\.png)?))?$/;
cpSync('static', out, { recursive: true, filter: (src) => ALLOWED.test(src.replace(/\\/g, '/')) });
const matches = ['https://x.com/*'];
if (e2e) matches.push('http://localhost/*', 'http://127.0.0.1/*');
const manifest = {
  manifest_version: 3,
  name: '__MSG_name__',
  short_name: 'X Engagement',
  description: '__MSG_short__',
  version: pkg.version,
  default_locale: 'en',
  icons: { 16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
  action: { default_title: '__MSG_name__', default_icon: { 16: 'icons/icon16.png', 48: 'icons/icon48.png' } },
  background: { service_worker: 'background.js' },
  content_scripts: [{ matches, js: ['content.js'], run_at: 'document_idle' }],
  // No "permissions" and no "host_permissions": IndexedDB needs none, the dashboard opens via chrome.tabs.create
  // (no "tabs" permission needed), and the license Worker answers with CORS headers.
  permissions: [],
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
};
writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest, null, 2));
const { checkRelease } = await import('./check_release.mjs');
const bad = checkRelease(out);
if (bad.length) { console.error('RELEASE CHECK FAILED:\n' + bad.join('\n')); process.exit(3); }
console.log(`built ${out}/ (v${pkg.version}${e2e ? ', e2e' : ''})`);
