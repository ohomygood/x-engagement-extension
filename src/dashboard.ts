/** Dashboard page (extension origin). Reads IndexedDB directly; renders with plain DOM, paginated for speed. */
// Free store edition: every feature is available, there is no plan, key, purchase or network request.
import { leaderboard, notFollowingBack, pendingReplies, toCSV, unfollowers } from './analytics';
import { accounts, getMeta, getSnapshots, getTweets, wipeAccount } from './db';
import { defaultLang, t, type Key, type Lang } from './i18n';
import { SITE } from './site';
import type { Snapshot, TweetRecord } from './types';

const PAGE = 100;
const state = { lang: defaultLang() as Lang, tab: 'leaderboard' as Tab, days: 7, account: '',
                tweets: [] as TweetRecord[], snaps: [] as Snapshot[], shown: PAGE };
type Tab = 'leaderboard' | 'pending' | 'notBack' | 'unfollowers' | 'settings';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const tr = (k: Key, v?: Record<string, string | number>) => t(state.lang, k, v);
const fmt = (ms: number) => new Date(ms).toLocaleString(state.lang === 'zh' ? 'zh-CN' : 'en-US', { dateStyle: 'short', timeStyle: 'short' });
const userLink = (h: string, name = '') => `<a href="https://x.com/${esc(h)}" target="_blank" rel="noopener">${esc(name || h)}</a> <span class="muted">@${esc(h)}</span>`;

function download(name: string, csv: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function table(head: string[], rows: string[][], total: number, csv?: () => string, csvName = 'export.csv'): string {
  if (!total) return '';
  const body = rows.slice(0, state.shown).map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
  const more = rows.length > state.shown ? `<button id="more">${tr('more')} (${rows.length - state.shown})</button>` : '';
  const exp = csv ? `<button id="csv">${tr('exportCsv')}</button>` : '';
  (window as unknown as { __csv?: () => void }).__csv = csv ? () => download(csvName, csv()) : undefined;
  return `<div class="tools">${exp}</div><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>${more}`;
}

function viewLeaderboard(): string {
  const days = state.days;
  const all = leaderboard(state.tweets, state.account, days);
  const rows = all;
  const sel = [7, 30, 90].map((d) => `<button class="seg ${d === days ? 'on' : ''}" data-days="${d}">${tr(('d' + d) as Key)}</button>`).join('');
  if (!all.length) return `<div class="seg-wrap">${sel}</div><p class="empty">${tr('empty')}</p>`;
  return `<div class="seg-wrap">${sel}</div>` + table(['#', tr('user'), tr('count'), tr('last')],
    rows.map((r, i) => [String(i + 1), userLink(r.handle, r.name), String(r.count), `<a href="${esc(r.lastUrl)}" target="_blank">${fmt(r.lastAt)}</a>`]),
    all.length, () => toCSV(all.map((r) => ({ handle: r.handle, name: r.name, comments: r.count, last_at: new Date(r.lastAt).toISOString(), last_url: r.lastUrl }))),
    `top-commenters-${days}d.csv`);
}

function viewPending(): string {
  const all = pendingReplies(state.tweets, state.account, 30);
  const rows = all;
  if (!all.length) return `<p class="empty">${tr('empty')}</p>`;
  return table([tr('user'), tr('comment'), tr('time'), ''],
    rows.map((c) => [userLink(c.author, c.name), esc(c.text.slice(0, 140)), fmt(c.time), `<a href="${esc(c.url)}" target="_blank">${tr('open')}</a>`]),
    all.length, () => toCSV(all.map((c) => ({ handle: c.author, name: c.name, text: c.text, time: new Date(c.time).toISOString(), url: c.url }))), 'to-reply.csv');
}

function latest(kind: 'following' | 'followers', completeOnly = true) {
  return state.snaps.filter((s) => s.kind === kind && (!completeOnly || s.complete)).sort((a, b) => b.takenAt - a.takenAt)[0];
}

function viewNotBack(): string {
  const snap = latest('following');
  if (!snap) return `<p class="empty">${tr('noSnap')}</p>`;
  const all = notFollowingBack(snap);
  const rows = all;
  return `<p class="muted">${tr('lastSnap')}: ${fmt(snap.takenAt)} · ${all.length}/${snap.users.length}</p>` +
    table([tr('user')], rows.map((u) => [userLink(u.handle, u.name)]), all.length,
      () => toCSV(all.map((u) => ({ handle: u.handle, name: u.name, url: `https://x.com/${u.handle}` }))), 'not-following-back.csv');
}

function viewUnfollowers(): string {
  const r = unfollowers(state.snaps);
  if (!r.ok) return `<p class="empty">${tr('needTwo')}</p>`;
  const rows = r.removed;
  return `<p class="muted">${fmt(r.from!)} → ${fmt(r.to!)} · ${tr('removed')}: ${r.removed.length} · ${tr('added')}: ${r.added.length}</p>` +
    (r.removed.length ? table([tr('removed')], rows.map((u) => [userLink(u.handle, u.name)]), r.removed.length,
      () => toCSV(r.removed.map((u) => ({ handle: u.handle, name: u.name }))), 'unfollowers.csv') : '');
}

async function viewSettings(): Promise<string> {
  const accs = await accounts();
  const health = await getMeta<{ url: string; at: number; health: Record<string, { matched: string | null; count: number }> }>('health');
  const diag = health ? `<table><tr><th>key</th><th>selector</th><th>#</th></tr>${Object.entries(health.health).map(([k, v]) =>
    `<tr><td>${esc(k)}</td><td class="${v.matched ? '' : 'bad'}">${esc(v.matched || '—')}</td><td>${v.count}</td></tr>`).join('')}</table>
    <p class="muted">${esc(health.url)} · ${fmt(health.at)}</p>` : '<p class="muted">—</p>';
  return `<section><h3>${tr('account')}</h3>${accs.map((a) => `<label><input type="radio" name="acc" value="${esc(a)}" ${a === state.account ? 'checked' : ''}> @${esc(a)}</label> `).join('') || '—'}
    ${state.account ? `<p><button id="wipe" class="danger">${tr('wipe')} (@${esc(state.account)})</button></p>` : ''}</section>
    <section><h3>${tr('diag')}</h3>${diag}</section><p class="muted">${tr('privacy')} · <a href="${esc(SITE.PRIVACY_URL)}" target="_blank" rel="noopener">${tr('privacyLink')}</a> · <a href="${esc(SITE.HOME_URL)}" target="_blank" rel="noopener">AI Seen Lab</a></p>`;
}

async function render() {
  document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : 'en';
  document.title = tr('title');
  $('#title').textContent = tr('title');
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('nav button'))) {
    b.textContent = tr(b.dataset.tab as Key);
    b.classList.toggle('on', b.dataset.tab === state.tab);
  }
  const views: Record<Tab, () => string | Promise<string>> = { leaderboard: viewLeaderboard, pending: viewPending,
    notBack: viewNotBack, unfollowers: viewUnfollowers, settings: viewSettings };
  $('#view').innerHTML = await views[state.tab]();
  bind();
}

function bind() {
  document.querySelectorAll<HTMLButtonElement>('[data-days]').forEach((b) => b.onclick = () => { state.days = +b.dataset.days!; state.shown = PAGE; render(); });
  const more = $('#more'); if (more) more.onclick = () => { state.shown += PAGE; render(); };
  const csv = $('#csv'); if (csv) csv.onclick = () => (window as unknown as { __csv?: () => void }).__csv?.();
  document.querySelectorAll<HTMLInputElement>('input[name=acc]').forEach((r) => r.onchange = () => load(r.value));
  const wipe = $('#wipe');
  if (wipe) wipe.onclick = async () => { if (confirm(tr('wipe') + '?')) { await wipeAccount(state.account); await load(''); } };
}

async function load(account: string) {
  const accs = await accounts();
  state.account = account || accs[0] || '';
  state.tweets = state.account ? await getTweets(state.account) : [];
  state.snaps = state.account ? await getSnapshots(state.account) : [];
  state.shown = PAGE;
  $('#acct').textContent = state.account ? '@' + state.account : '';
  await render();
}

export async function init() {
  document.querySelectorAll<HTMLButtonElement>('nav button').forEach((b) => b.onclick = () => { state.tab = b.dataset.tab as Tab; state.shown = PAGE; render(); });
  $('#lang').onclick = () => { state.lang = state.lang === 'zh' ? 'en' : 'zh'; render(); };
  await load('');
}

init();
