/** Pure DOM parsing. No chrome.* APIs here so it runs in tests (jsdom) and in the content script. */
import { q, qa, TEXT } from './selectors';
import type { PageInfo, TweetRecord, UserCell } from './types';

const RESERVED = new Set(['home', 'explore', 'notifications', 'messages', 'i', 'settings', 'search', 'compose',
  'login', 'logout', 'signup', 'tos', 'privacy', 'jobs', 'premium', 'communities', 'lists', 'bookmarks']);

const norm = (h: string) => h.replace(/^@/, '').trim().toLowerCase();

export function detectPage(url: string): PageInfo {
  const u = new URL(url);
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] === 'notifications') return { kind: 'notifications' };
  if (parts.length >= 3 && parts[1] === 'status' && /^\d+$/.test(parts[2]))
    return { kind: 'status', handle: norm(parts[0]), statusId: parts[2] };
  if (parts.length >= 2 && !RESERVED.has(parts[0].toLowerCase())) {
    if (parts[1] === 'following') return { kind: 'following', handle: norm(parts[0]) };
    if (parts[1] === 'followers' || parts[1] === 'verified_followers') return { kind: 'followers', handle: norm(parts[0]) };
  }
  if (parts.length >= 1 && !RESERVED.has(parts[0].toLowerCase())) return { kind: 'profile', handle: norm(parts[0]) };
  return { kind: 'other' };
}

/** Signed-in user's handle from the left nav "Profile" link. */
export function detectMe(root: ParentNode): string | null {
  const a = q<HTMLAnchorElement>(root, 'profileNav');
  const href = a?.getAttribute('href') || '';
  const m = href.match(/^\/([A-Za-z0-9_]{1,15})$/);
  return m ? norm(m[1]) : null;
}

function handleFromHref(href: string | null): string | null {
  const m = (href || '').match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
  return m && !RESERVED.has(m[1].toLowerCase()) ? norm(m[1]) : null;
}

function replyingTo(article: Element): string[] {
  // "Replying to @a and @b" block: a div whose text starts with a localized "Replying to" and contains @links
  const out: string[] = [];
  for (const div of Array.from(article.querySelectorAll('div'))) {
    const t = (div.textContent || '').trim();
    if (!TEXT.replyingTo.some((p) => t.startsWith(p)) || t.length > 300) continue;
    for (const a of Array.from(div.querySelectorAll('a[href^="/"]'))) {
      const h = handleFromHref(a.getAttribute('href'));
      if (h && (a.textContent || '').trim().startsWith('@')) out.push(h);
    }
    if (out.length) break;
  }
  return Array.from(new Set(out));
}

export function parseTweet(article: Element, account: string, now = Date.now()): TweetRecord | null {
  const timeEl = q<HTMLTimeElement>(article, 'time');
  const link = timeEl?.closest('a[href*="/status/"]') as HTMLAnchorElement | null;
  const href = link?.getAttribute('href') || '';
  const m = href.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/);
  if (!m || !timeEl) return null; // ads / placeholders / "show more" stubs have no permalink time
  const nameBlock = q(article, 'userName');
  const name = (nameBlock?.querySelector('span')?.textContent || '').trim();
  const textEl = q<HTMLElement>(article, 'tweetText');
  return {
    id: m[2], account, author: norm(m[1]), name, text: (textEl?.textContent || '').trim().slice(0, 500),
    time: Date.parse(timeEl.getAttribute('datetime') || '') || now, replyTo: replyingTo(article),
    url: `https://x.com/${m[1]}/status/${m[2]}`, seenAt: now,
  };
}

function isRepost(article: Element): boolean {
  const ctx = q(article, 'socialContext');
  const t = (ctx?.textContent || '').toLowerCase();
  return TEXT.reposted.some((p) => t.includes(p.toLowerCase()));
}

/**
 * Parse all tweets on the current page. On a status page the focal tweet is identified from the URL;
 * tweets rendered after it are replies in that conversation. A reply without an explicit "Replying to"
 * line that sits directly under the focal tweet is attributed to the focal tweet's author.
 */
export function parsePage(root: ParentNode, url: string, account: string, now = Date.now()): TweetRecord[] {
  const page = detectPage(url);
  const arts = qa(root, 'tweet');
  const out: TweetRecord[] = [];
  let focal: TweetRecord | null = null;
  let prev: TweetRecord | null = null;
  for (const a of arts) {
    if (isRepost(a)) continue;
    const t = parseTweet(a, account, now);
    if (!t) continue;
    if (page.kind === 'status') {
      if (t.id === page.statusId) {
        focal = t;
      } else if (focal) {
        t.convoId = focal.id;
        if (!t.replyTo.length) {
          // X omits "Replying to" for direct replies in a thread view; a reply right after another reply by
          // a different author in the same visual thread is ambiguous, so attribute to the focal author.
          t.replyTo = [focal.author];
          t.parentId = focal.id;
        } else if (t.replyTo.length === 1 && t.replyTo[0] === focal.author) {
          t.parentId = focal.id;
        } else if (prev && t.replyTo.includes(prev.author)) {
          t.parentId = prev.id;
        }
      }
      if (focal && t.id === focal.id) t.convoId = focal.id;
    }
    out.push(t);
    prev = t;
  }
  return out;
}

export function parseUserCells(root: ParentNode): UserCell[] {
  const out: UserCell[] = [];
  const seen = new Set<string>();
  for (const cell of qa(root, 'userCell')) {
    let handle: string | null = null;
    for (const a of Array.from(cell.querySelectorAll('a[href^="/"]'))) {
      handle = handleFromHref(a.getAttribute('href'));
      if (handle) break;
    }
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);
    const name = (cell.querySelector('a[href^="/"] span')?.textContent || '').trim();
    const indicator = q(cell, 'followsYou');
    const text = cell.textContent || '';
    out.push({ handle, name, followsYou: !!indicator || TEXT.followsYou.some((p) => text.includes(p)) });
  }
  return out;
}
