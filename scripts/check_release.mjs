// Release guard: no payment QR / WeChat asset or copy may ever ship in a build dir, zip, or the static site.
//   node scripts/check_release.mjs <dir-or-zip>...      (exit 1 on findings)
// Rules: images only as icons/icon{16,32,48,128}.png (extension) or screenshots/*.png (site); no QR/WeChat-like
// file names; no file byte-identical to the owner's real QR (if present on this machine); no WeChat / ¥ copy.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REAL_QR = process.env.XENG_REAL_QR_PATH || '/workspace/payment/wechat_pay_qr.jpg';
const realHash = existsSync(REAL_QR) ? createHash('sha256').update(readFileSync(REAL_QR)).digest('hex') : null;
const NAME_RE = /qr|wechat|weixin|wxpay/i;
const IMG_RE = /\.(jpe?g|png|gif|webp|svg|bmp|ico)$/i;
// AI Seen Lab brand files: allowed under brand/ (or as /favicon.ico) only when byte-identical to a file in the repo's brand/.
const here = (() => { try { return fileURLToPath(new URL('../brand/', import.meta.url)); } catch { return ''; } })();   // vitest: non-file URL
const BRAND_DIR = [here, join(process.cwd(), 'brand')].find((d) => d && existsSync(d)) || '';
const brandHashes = BRAND_DIR ? new Set(readdirSync(BRAND_DIR).map((f) => createHash('sha256').update(readFileSync(join(BRAND_DIR, f))).digest('hex'))) : new Set();
const BRAND_PATH = /^([a-z0-9-]+\/)?(brand\/[a-z0-9_-]+\.(png|svg|ico)|favicon\.ico)$/;
const OK_IMG = /^([a-z0-9-]+\/)?(icons\/icon(16|32|48|128)\.png|screenshots\/[a-z0-9-]+\.png)$/;   // optional single top folder (dev zip)
const TEXT_RE = /\.(html|js|css|json|md|txt)$/i;
const BAD_TEXT = /微信|wechat|weixin|收款码|¥\s?\d|[\w/.-]*qr[\w-]*\.(?:jpe?g|png|webp|gif)/i;

export function checkFile(rel, data) {
  const out = [];
  if (realHash && createHash('sha256').update(data).digest('hex') === realHash) out.push(`${rel}: is the real payment QR`);
  const base = rel.split('/').pop();
  if (NAME_RE.test(base)) out.push(`${rel}: QR/WeChat-like file name`);
  const isBrand = BRAND_PATH.test(rel) && brandHashes.has(createHash('sha256').update(data).digest('hex'));
  if (IMG_RE.test(rel) && !OK_IMG.test(rel) && !isBrand) out.push(`${rel}: unexpected image`);
  if (TEXT_RE.test(rel)) { const m = BAD_TEXT.exec(data.toString('utf8')); if (m) out.push(`${rel}: WeChat/QR payment text ${JSON.stringify(m[0])}`); }
  return out;
}

function walk(dir) { return readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; }); }

export function checkRelease(dir) {
  return walk(dir).flatMap((p) => checkFile(relative(dir, p).replace(/\\/g, '/'), readFileSync(p)));
}

/** Zip entries are read with python3's zipfile (no extra dependency). */
export function checkZip(zip) {
  const py = `import zipfile,sys,json,base64
z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({n: base64.b64encode(z.read(n)).decode() for n in z.namelist() if not n.endswith('/')}))`;
  const files = JSON.parse(execFileSync('python3', ['-c', py, zip], { maxBuffer: 1 << 28 }).toString());
  return Object.entries(files).flatMap(([n, b64]) => checkFile(n, Buffer.from(b64, 'base64')));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const bad = process.argv.slice(2).flatMap((t) => (t.endsWith('.zip') ? checkZip(t) : checkRelease(t)));
  for (const b of bad) console.error('RELEASE CHECK:', b);
  process.exit(bad.length ? 1 : 0);
}
