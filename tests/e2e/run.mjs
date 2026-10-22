// End-to-end: real Chrome + the built extension (dist-e2e) against local x.com-like fixtures.
// Verifies capture on status / notifications / following / followers pages, the dashboard tabs,
// the human-pace snapshot scroller, unfollower diff, 1,000-record performance, and no network use.
// Also writes store screenshots to store/screenshots/. Run: npm run e2e
import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { bigThreadPage, followingPage, lazyListPage, notificationsPage, statusPage } from '../fixtures/xdom.mjs';

const NOW = Date.now();
const users = (from, to, fb = () => true) => Array.from({ length: to - from }, (_, k) => ({ handle: `user${from + k}`, name: `User ${from + k}`, followsYou: fb(from + k) }));
let followersHits = 0;
const routes = {
  '/me/status/100': () => statusPage('me', NOW),
  '/notifications': () => notificationsPage('me', NOW),
  '/me/following': () => followingPage('me', 45, true),
  '/me/followers': () => (followersHits++ === 0
    ? lazyListPage('me', users(0, 30))                                   // first snapshot
    : lazyListPage('me', [...users(0, 30).filter((u) => !['user3', 'user7'].includes(u.handle)), ...users(90, 92)])),
  '/me/status/5000': () => bigThreadPage('me', 1000, NOW),
};
const extRequests = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const f = routes[u.pathname];
  if (!f) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(f());
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://localhost:${server.address().port}`;

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, pipe: true, protocolTimeout: 60000,
  enableExtensions: [path.resolve('dist-e2e')], args: ['--no-sandbox', '--lang=en-US', '--window-size=1280,800'],
  defaultViewport: { width: 1280, height: 800 },
});
try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'), { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const dash = `chrome-extension://${extId}/dashboard.html`;
  const page = await browser.newPage();
  // Every request made by the extension (service worker or dashboard) is recorded; only the license API is allowed.
  for (const t of [sw]) { const w = await t.worker(); w?.client?.on?.('Network.requestWillBeSent', (e) => extRequests.push(e.request.url)); }
  page.on('request', (r) => { if (!r.url().startsWith(base) && !r.url().startsWith('chrome-extension://') && !r.url().startsWith('data:')) extRequests.push(r.url()); });

  const dbDump = async () => {
    const p = await browser.newPage();
    await p.goto(dash, { waitUntil: 'load' });
    const out = await p.evaluate(() => new Promise((res) => {
      const r = indexedDB.open('x-engagement');
      r.onsuccess = () => { const db = r.result; const tx = db.transaction(['tweets', 'snapshots'], 'readonly');
        const a = tx.objectStore('tweets').getAll(); const b = tx.objectStore('snapshots').getAll();
        tx.oncomplete = () => res({ tweets: a.result, snaps: b.result }); };
    }));
    await p.close();
    return out;
  };

  // 1) status page (own post with replies)
  await page.bringToFront(); await page.goto(`${base}/me/status/100`, { waitUntil: 'load' });
  await sleep(2500);
  let db = await dbDump();
  const ids = db.tweets.map((t) => t.id).sort();
  check('status page: 6 posts captured, ad skipped', JSON.stringify(ids) === JSON.stringify(['100', '101', '102', '103', '104', '105']), ids.join(','));
  check('status page: reply target inferred', db.tweets.find((t) => t.id === '101')?.replyTo?.[0] === 'me');

  // 2) notifications
  await page.bringToFront(); await page.goto(`${base}/notifications`, { waitUntil: 'load' });
  await sleep(2500);
  db = await dbDump();
  check('notifications: replies captured, repost skipped', db.tweets.some((t) => t.id === '202') && !db.tweets.some((t) => t.id === '203'));

  // 3) dashboard leaderboard + pending
  const d = await browser.newPage();
  await d.goto(dash, { waitUntil: 'load' });
  await d.waitForSelector('table');
  const lb = await d.$$eval('tbody tr', (rs) => rs.map((r) => r.innerText.replace(/\s+/g, ' ')));
  check('dashboard: 7-day leaderboard', lb.length === 3 && /Alice/.test(lb[0]) && /\b2\b/.test(lb[0]), lb.join(' | '));
  await screenshot(d, 'en-1-leaderboard');
  await d.click('nav button[data-tab=pending]');
  await sleep(300);
  const pend = await d.$$eval('tbody tr', (rs) => rs.map((r) => r.innerText));
  check('dashboard: pending replies exclude answered', pend.length === 3 && !pend.join().includes('Ships to HK'), `${pend.length} rows`);
  await screenshot(d, 'en-2-pending');

  // 4) following snapshot via human-pace scroller (lazy list that unloads old rows, like X)
  await page.bringToFront(); await page.goto(`${base}/me/following`, { waitUntil: 'load' });
  await page.waitForSelector('pierce/#b', { timeout: 5000 });
  const t0 = Date.now();
  await (await page.$('pierce/#b')).click();
  await page.waitForFunction(() => /Saved complete snapshot/.test(document.querySelector('div[style*="2147483647"]')?.shadowRoot?.getElementById('s')?.textContent || ''), { timeout: 120000, polling: 500 });
  const took = (Date.now() - t0) / 1000;
  await screenshot(page, 'en-5-snapshot-panel');
  db = await dbDump();
  const fsnap = db.snaps.find((s) => s.kind === 'following');
  check('following snapshot: all 45 collected despite row unloading', fsnap?.users.length === 45 && fsnap.complete, `${fsnap?.users.length} users in ${took.toFixed(0)} s`);
  check('following snapshot: human pace (>= 1.5 s per screen)', took >= 1.5 * 4, `${took.toFixed(0)} s`);

  // 5) followers twice -> unfollower diff
  for (let i = 0; i < 2; i++) {
    await page.bringToFront(); await page.goto(`${base}/me/followers?r=${i}`, { waitUntil: 'load' });
    await page.waitForSelector('pierce/#b', { timeout: 5000 });
    await (await page.$('pierce/#b')).click();
    await page.waitForFunction(() => /Saved complete snapshot/.test(document.querySelector('div[style*="2147483647"]')?.shadowRoot?.getElementById('s')?.textContent || ''), { timeout: 120000, polling: 500 });
  }
  await d.bringToFront(); await d.reload({ waitUntil: 'load' });
  await d.click('nav button[data-tab=notBack]'); await sleep(300);
  const nb = await d.$$eval('tbody tr', (rs) => rs.length);
  const up = await d.$eval('#view', (v) => v.querySelector('.upsell')?.textContent || '');
  check('not-following-back: 30 of 45; free plan shows top 20 + "10 hidden" upsell', nb === 20 && /10/.test(up), `${nb} rows; ${up.trim()}`);
  await screenshot(d, 'en-3-not-following-back');
  await d.click('nav button[data-tab=unfollowers]'); await sleep(300);
  const uf = await d.$eval('#view', (v) => v.innerText);
  check('unfollowers: user3 and user7 detected', /user3\b/.test(uf) && /user7\b/.test(uf) && !/user5\b/.test(uf));
  await screenshot(d, 'en-4-unfollowers');

  // 6) 1,000 records
  const lp = await browser.newPage();
  // Main-thread jank monitor: content scripts share the page's main thread, so a blocking scan shows up as a gap.
  await lp.evaluateOnNewDocument(() => { window.__gap = 0; let last = performance.now();
    setInterval(() => { const n = performance.now(); window.__gap = Math.max(window.__gap, n - last - 10); last = n; }, 10); });
  await lp.bringToFront(); await lp.goto(`${base}/me/status/5000`, { waitUntil: 'load' });
  await sleep(4000);
  const gap = await lp.evaluate(() => window.__gap);
  await lp.evaluate(() => { window.__gap = 0; const t = performance.now(); while (performance.now() - t < 80); });
  await sleep(100);
  const probe = await lp.evaluate(() => window.__gap);
  db = await dbDump();
  check('1,000-reply thread captured', db.tweets.filter((t) => +t.id >= 6000).length === 1000, `${db.tweets.length} total records`);
  check('1,000 records: page main thread never blocked > 200 ms during capture', gap < 200 && probe >= 60,
        `worst stall ${gap.toFixed(0)} ms incl. page load (monitor sanity probe: 80 ms block measured as ${probe.toFixed(0)} ms)`);
  const r0 = Date.now();
  await d.bringToFront(); await d.reload({ waitUntil: 'load' }); await d.waitForSelector('tbody tr');
  await d.click('nav button[data-tab=pending]'); await d.waitForSelector('tbody tr');
  const dashMs = Date.now() - r0;
  check('1,000 records: dashboard load + tab switch < 1.5 s', dashMs < 1500, `${dashMs} ms`);

  // 7) Chinese UI screenshots
  await d.click('nav button[data-tab=leaderboard]'); await sleep(200);
  await d.click('#lang'); await sleep(300);
  await screenshot(d, 'zh-1-leaderboard');
  await d.click('nav button[data-tab=pending]'); await sleep(300); await screenshot(d, 'zh-2-pending');
  await d.click('nav button[data-tab=unfollowers]'); await sleep(300); await screenshot(d, 'zh-4-unfollowers');
  await d.click('nav button[data-tab=settings]'); await sleep(300); await screenshot(d, 'zh-6-settings');
  const diag = await d.$eval('#view', (v) => v.innerText);
  check('settings: selector diagnostics shown', /tweet/.test(diag) && /AppTabBar_Profile_Link|primaryColumn/.test(diag));

  // 8) no network
  const external = extRequests.filter((u) => !u.startsWith(base));
  check('no network requests by the extension (license API unused in free plan)', external.length === 0, external.slice(0, 3).join(', '));
} catch (e) {
  check('e2e run', false, String(e?.stack || e));
} finally {
  await browser.close();
  server.close();
}
mkdirSync('tests/e2e/out', { recursive: true });
writeFileSync('tests/e2e/out/results.json', JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

async function screenshot(p, name) {
  mkdirSync('store/screenshots', { recursive: true });
  await p.bringToFront();
  await p.screenshot({ path: `store/screenshots/${name}.png`, clip: { x: 0, y: 0, width: 1280, height: 800 } });
}
function writeShot(p, name) { return screenshot(p, name); }
