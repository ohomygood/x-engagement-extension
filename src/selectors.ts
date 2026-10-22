/**
 * ALL x.com DOM knowledge lives in this file. When X changes its markup, fix it here only.
 * Each key has an ordered list of selectors; the first that matches wins (fallbacks below the primary).
 * `selectorHealth()` reports which keys matched on the current page; the dashboard's Diagnostics tab
 * shows it so a breakage can be located and fixed within a day.
 */
export const SELECTORS = {
  tweet: ['article[data-testid="tweet"]', 'article[role="article"]'],
  userName: ['[data-testid="User-Name"]', 'div[dir="ltr"] > span'],
  tweetText: ['[data-testid="tweetText"]', 'div[lang]'],
  time: ['time[datetime]'],
  socialContext: ['[data-testid="socialContext"]'],
  userCell: ['[data-testid="UserCell"]', 'button[data-testid="UserCell"]', 'div[data-testid="cellInnerDiv"] [role="button"]'],
  followsYou: ['[data-testid="userFollowIndicator"]'],
  profileNav: ['a[data-testid="AppTabBar_Profile_Link"]', 'nav a[aria-label="Profile"]', 'nav a[aria-label="个人资料"]'],
  primaryColumn: ['[data-testid="primaryColumn"]', 'main[role="main"]'],
} as const;

export type SelectorKey = keyof typeof SELECTORS;

/** Text fallbacks (EN / 简体 / 繁體 / 日本語) for elements without stable test ids. */
export const TEXT = {
  followsYou: ['Follows you', '关注了你', '跟隨你', 'フォローされています'],
  replyingTo: ['Replying to', '回复', '回覆', '返信先'],
  reposted: ['reposted', '转帖了', '已轉發', 'さんがリポスト'],
};

export function q<T extends Element = Element>(root: ParentNode, key: SelectorKey): T | null {
  for (const s of SELECTORS[key]) {
    const el = root.querySelector<T>(s);
    if (el) return el;
  }
  return null;
}

export function qa<T extends Element = Element>(root: ParentNode, key: SelectorKey): T[] {
  for (const s of SELECTORS[key]) {
    const els = Array.from(root.querySelectorAll<T>(s));
    if (els.length) return els;
  }
  return [];
}

export function selectorHealth(root: ParentNode): Record<string, { matched: string | null; count: number }> {
  const out: Record<string, { matched: string | null; count: number }> = {};
  for (const key of Object.keys(SELECTORS) as SelectorKey[]) {
    out[key] = { matched: null, count: 0 };
    for (const s of SELECTORS[key]) {
      const n = root.querySelectorAll(s).length;
      if (n) { out[key] = { matched: s, count: n }; break; }
    }
  }
  return out;
}
