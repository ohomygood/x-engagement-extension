/**
 * Content script on x.com. Reads ONLY what the user has on screen; never clicks, follows, likes or posts.
 * The one active behaviour is the optional, user-started "snapshot" on the user's own Following/Followers
 * page, which scrolls at a human pace (one screen every 1.5–2.5 s) and can be stopped at any time.
 */
import { detectMe, detectPage, parsePage, parseUserCells } from './parse';
import { selectorHealth } from './selectors';
import type { Snapshot, UserCell } from './types';

const sentIds = new Set<string>();
let lastUrl = '';
let lastHealthAt = 0;
let panel: HTMLElement | null = null;
let run: { kind: 'following' | 'followers'; account: string; users: Map<string, UserCell>; idle: number; timer?: number } | null = null;

function send(msg: unknown) {
  try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch { /* extension reloaded */ }
}

function scan() {
  const me = detectMe(document);
  if (!me) return;
  const page = detectPage(location.href);
  if (location.href !== lastUrl) { lastUrl = location.href; removePanel(); }
  if (Date.now() - lastHealthAt > 60_000) {
    lastHealthAt = Date.now();
    send({ type: 'health', account: me, url: location.pathname, health: selectorHealth(document) });
  }
  if ((page.kind === 'following' || page.kind === 'followers') && page.handle === me) {
    ensurePanel(page.kind, me);
    if (run) for (const u of parseUserCells(document)) run.users.set(u.handle, u);
    updatePanel();
    return;
  }
  const tweets = parsePage(document, location.href, me).filter((t) => {
    const k = `${t.id}:${t.parentId || ''}:${t.replyTo.join(',')}`;
    if (sentIds.has(k)) return false;
    sentIds.add(k);
    return true;
  });
  for (let i = 0; i < tweets.length; i += 200) send({ type: 'tweets', account: me, tweets: tweets.slice(i, i + 200) });
}

// ---------------------------------------------------------------- snapshot panel (own lists only)
const L = (zh: string, en: string) => (navigator.language.toLowerCase().startsWith('zh') ? zh : en);

function ensurePanel(kind: 'following' | 'followers', account: string) {
  if (panel) return;
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>div{font:13px system-ui,sans-serif;background:#fff;color:#0f1419;border:1px solid #cfd9de;border-radius:12px;
    padding:10px 12px;box-shadow:0 4px 16px rgba(0,0,0,.15);max-width:260px}button{margin-top:6px;border:0;border-radius:999px;
    padding:6px 12px;background:#1d9bf0;color:#fff;font-weight:700;cursor:pointer}button.stop{background:#536471}</style>
    <div><b>${L('互动名单助手', 'Engagement List')}</b><p id="s"></p><button id="b"></button></div>`;
  document.documentElement.appendChild(host);
  panel = host;
  root.getElementById('b')!.addEventListener('click', () => (run ? stopRun(false) : startRun(kind, account)));
  updatePanel();
}

function updatePanel() {
  const root = panel?.shadowRoot;
  if (!root) return;
  const s = root.getElementById('s')!;
  const b = root.getElementById('b') as HTMLButtonElement;
  if (run) {
    s.textContent = L(`正在记录… 已收集 ${run.users.size} 人`, `Recording… ${run.users.size} accounts`);
    b.textContent = L('停止（保存为不完整快照）', 'Stop (save as partial)');
    b.className = 'stop';
  } else {
    s.textContent = L('自动慢速滚动到底，保存名单快照，用于对比未回关和取关。', 'Scrolls slowly to the end and saves a snapshot to compare who doesn’t follow back / unfollowed.');
    b.textContent = L('开始记录快照', 'Start snapshot');
    b.className = '';
  }
}

function startRun(kind: 'following' | 'followers', account: string) {
  run = { kind, account, users: new Map(), idle: 0 };
  window.scrollTo(0, 0);
  tick();
}

function tick() {
  if (!run) return;
  const before = run.users.size;
  for (const u of parseUserCells(document)) run.users.set(u.handle, u);
  const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 50;
  run.idle = run.users.size === before && atBottom ? run.idle + 1 : 0;
  updatePanel();
  if (run.idle >= 4 || run.users.size >= 20000) return stopRun(run.idle >= 4);
  window.scrollBy({ top: Math.round(window.innerHeight * 0.85), behavior: 'smooth' });
  run.timer = window.setTimeout(tick, 1500 + Math.random() * 1000);
}

function stopRun(complete: boolean) {
  if (!run) return;
  clearTimeout(run.timer);
  const snap: Snapshot = { account: run.account, kind: run.kind, takenAt: Date.now(), complete, users: [...run.users.values()] };
  send({ type: 'snapshot', snapshot: snap });
  const n = run.users.size;
  run = null;
  updatePanel();
  const s = panel?.shadowRoot?.getElementById('s');
  if (s) s.textContent = complete ? L(`已保存完整快照：${n} 人`, `Saved complete snapshot: ${n}`)
                                  : L(`已保存不完整快照：${n} 人（不会用于取关对比）`, `Saved partial snapshot: ${n} (not used for unfollow diff)`);
}

function removePanel() {
  if (run) stopRun(false);
  panel?.remove();
  panel = null;
}

// ---------------------------------------------------------------- wiring
let pending = 0;
const schedule = () => { if (!pending) pending = window.setTimeout(() => { pending = 0; scan(); }, 800); };
new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
setInterval(() => { if (location.href !== lastUrl) schedule(); }, 1000); // SPA navigation
schedule();
