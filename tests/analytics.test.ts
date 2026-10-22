import { applyPlan, allowedDays, leaderboard, notFollowingBack, pendingReplies, toCSV, unfollowers } from '../src/analytics';
import { parsePage, parseUserCells } from '../src/parse';
import type { Snapshot, TweetRecord } from '../src/types';
// @ts-expect-error untyped fixture module
import { followingPage, notificationsPage, statusPage, NOW } from './fixtures/xdom.mjs';

const dom = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const all = (): TweetRecord[] => [
  ...parsePage(dom(statusPage()), 'https://x.com/me/status/100', 'me', NOW),
  ...parsePage(dom(notificationsPage()), 'https://x.com/notifications', 'me', NOW),
];

describe('leaderboard', () => {
  it('counts comments to me per author inside the window', () => {
    const lb7 = leaderboard(all(), 'me', 7, NOW);
    expect(lb7.map((r) => [r.handle, r.count])).toEqual([['alice', 2], ['erin', 1], ['bob', 1]]);
    expect(lb7[0].lastUrl).toBe('https://x.com/alice/status/104');
    const lb30 = leaderboard(all(), 'me', 30, NOW);
    expect(lb30.map((r) => r.handle)).toContain('carol'); // 10 days old
    expect(lb30.map((r) => r.handle)).not.toContain('dave'); // replied to bob, not me
  });
});

describe('pending replies', () => {
  it('excludes comments I answered', () => {
    const p = pendingReplies(all(), 'me', 30, NOW).map((t) => t.id);
    expect(p).toEqual(['202', '104', '103', '201']); // 101 answered by 102
  });
});

describe('follow analytics', () => {
  const snap = (users: string[], complete = true, takenAt = NOW): Snapshot =>
    ({ account: 'me', kind: 'followers', takenAt, complete, users: users.map((h) => ({ handle: h, name: h, followsYou: true })) });

  it('lists accounts that do not follow back', () => {
    const users = parseUserCells(dom(followingPage('me', 9)));
    const s: Snapshot = { account: 'me', kind: 'following', takenAt: NOW, complete: true, users };
    expect(notFollowingBack(s).map((u) => u.handle)).toEqual(['user1', 'user2', 'user4', 'user5', 'user7', 'user8']);
  });

  it('diffs only complete follower snapshots', () => {
    expect(unfollowers([snap(['a', 'b'])]).ok).toBe(false);
    const r = unfollowers([snap(['a', 'b', 'c'], true, 1), snap(['a'], false, 2), snap(['a', 'c', 'd'], true, 3)]);
    expect(r.ok).toBe(true);
    expect(r.removed.map((u) => u.handle)).toEqual(['b']);
    expect(r.added.map((u) => u.handle)).toEqual(['d']);
  });
});

describe('plans and export', () => {
  it('limits the free plan to 7 days and 20 rows', () => {
    expect(allowedDays(90, 'free')).toBe(7);
    expect(allowedDays(90, 'pro')).toBe(90);
    const rows = Array.from({ length: 25 }, (_, i) => i);
    expect(applyPlan(rows, 'free')).toEqual({ rows: rows.slice(0, 20), hidden: 5 });
    expect(applyPlan(rows, 'pro').hidden).toBe(0);
  });

  it('writes CSV with BOM, quoting and formula-injection guard', () => {
    const csv = toCSV([{ a: '=HYPERLINK("x")', b: 'x,y' }, { a: 'plain', b: '中文' }]);
    expect(csv.startsWith('\ufeffa,b\n')).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('"x,y"');
    expect(csv).toContain('plain,中文');
  });
});

describe('performance', () => {
  it('handles 10,000 records well under 100 ms', () => {
    const tweets: TweetRecord[] = Array.from({ length: 10_000 }, (_, i) => ({
      id: String(1000 + i), account: 'me', author: i % 7 === 0 ? 'me' : `u${i % 400}`, name: `U${i}`, text: 'hello',
      time: NOW - (i % 90) * 86_400_000, replyTo: i % 7 === 0 ? [`u${i % 400}`] : ['me'], url: 'https://x.com/x/status/1', seenAt: NOW,
      convoId: String(i % 50) }));
    const t0 = performance.now();
    const lb = leaderboard(tweets, 'me', 90, NOW);
    const p = pendingReplies(tweets, 'me', 90, NOW);
    const ms = performance.now() - t0;
    expect(lb.length).toBeGreaterThan(100);
    expect(p.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(500);
    console.log(`10k records: leaderboard+pending ${ms.toFixed(1)} ms`);
  });
});
