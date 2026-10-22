// Zip dist/ into release/x-engagement-list-<version>.zip for the Chrome Web Store. Refuses placeholder config.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const bundle = readdirSync('dist').filter((f) => f.endsWith('.js')).map((f) => readFileSync(`dist/${f}`, 'utf8')).join('\n');
const placeholders = ['__XENG_DOMAIN__', '__PENDING_XENG_PRO__', '__PENDING__'].filter((p) => bundle.includes(p));
if (placeholders.length && !process.argv.includes('--allow-placeholders')) {
  console.error(`dist still contains placeholders: ${placeholders.join(', ')} (store build needs the real Worker URL, Payment Link and public key). Use --allow-placeholders for a review-only zip.`);
  process.exit(2);
}
mkdirSync('release', { recursive: true });
const out = `release/x-engagement-list-${version}${placeholders.length ? '-PLACEHOLDERS' : ''}.zip`;
rmSync(out, { force: true });
// python3's zipfile is available everywhere we build (no dependency on the `zip` binary)
execFileSync('python3', ['-c', `import os,sys,zipfile
z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED)
for r,_,fs in os.walk('dist'):
    for f in sorted(fs):
        p=os.path.join(r,f); z.write(p, os.path.relpath(p,'dist'))
z.close()`, out], { stdio: 'inherit' });
const { checkZip } = await import('./check_release.mjs');
const bad = checkZip(out);
if (bad.length) { rmSync(out, { force: true }); console.error('RELEASE CHECK FAILED (zip deleted):\n' + bad.join('\n')); process.exit(3); }
console.log(`wrote ${out}`);
