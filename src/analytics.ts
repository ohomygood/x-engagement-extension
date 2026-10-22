/** Pure analytics over captured records. Everything runs locally in the extension. */
import type { Plan, Snapshot, TweetRecord, UserCell } from './types';

export const FREE_LIMITS = { days: 7, rows: 20 } as const;
const DAY = 86_400_000;

export interface LeaderRow { handle: string; name: string; count: number; lastAt: number; lastUrl: string }

export function commentsToMe(tweets: TweetRecord[], me: string): TweetRecord[] {
  return tweets.filter((t) => t.author !== me && t.replyTo.includes(me));
}

export function leaderboard(tweets: TweetRecord[], me: string, days: number, now = Date.now()): LeaderRow[] {
  const since = now - days * DAY;
  const by = new Map<string, LeaderRow>();
  for (const t of commentsToMe(tweets, me)) {
    if (t.time < since) continue;
    const r = by.get(t.author) || { handle: t.author, name: t.name, count: 0, lastAt: 0, lastUrl: t.url };
    r.count++;
    if (t.time > r.lastAt) { r.lastAt = t.time; r.lastUrl = t.url; r.name = t.name || r.name; }
    by.set(t.author, r);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt || a.handle.localeCompare(b.handle));
}

/**
 * Comments to me that I have not answered. A comment counts as answered when I posted, after it,
 * a tweet whose parent is that comment, or which replies to its author in the same conversation.
 */
export function pendingReplies(tweets: TweetRecord[], me: string, days = 30, now = Date.now()): TweetRecord[] {
  const mine = tweets.filter((t) => t.author === me);
  const since = now - days * DAY;
  return commentsToMe(tweets, me)
    .filter((c) => c.time >= since)
    .filter((c) => !mine.some((m) => m.time >= c.time && (m.parentId === c.id ||
      (m.replyTo.includes(c.author) && (!m.convoId || !c.convoId || m.convoId === c.convoId)))))
    .sort((a, b) => b.time - a.time);
}

export function notFollowingBack(following: Snapshot | undefined): UserCell[] {
  return following ? following.users.filter((u) => !u.followsYou) : [];
}

export interface UnfollowResult { ok: boolean; reason?: string; removed: UserCell[]; added: UserCell[]; from?: number; to?: number }

/** Compare the two most recent COMPLETE follower snapshots. Partial snapshots are never diffed (false positives). */
export function unfollowers(snaps: Snapshot[]): UnfollowResult {
  const done = snaps.filter((s) => s.kind === 'followers' && s.complete).sort((a, b) => a.takenAt - b.takenAt);
  if (done.length < 2) return { ok: false, reason: 'need-two-complete-snapshots', removed: [], added: [] };
  const [prev, cur] = done.slice(-2);
  const curSet = new Set(cur.users.map((u) => u.handle));
  const prevSet = new Set(prev.users.map((u) => u.handle));
  return { ok: true, removed: prev.users.filter((u) => !curSet.has(u.handle)),
           added: cur.users.filter((u) => !prevSet.has(u.handle)), from: prev.takenAt, to: cur.takenAt };
}

export function applyPlan<T>(rows: T[], plan: Plan): { rows: T[]; hidden: number } {
  if (plan === 'pro') return { rows, hidden: 0 };
  return { rows: rows.slice(0, FREE_LIMITS.rows), hidden: Math.max(0, rows.length - FREE_LIMITS.rows) };
}

export function allowedDays(days: number, plan: Plan): number {
  return plan === 'pro' ? days : FREE_LIMITS.days;
}

const csvCell = (v: unknown) => {
  const s = String(v ?? '');
  // neutralise spreadsheet formula injection
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function toCSV(rows: Record<string, unknown>[], columns?: string[]): string {
  if (!rows.length) return '';
  const cols = columns || Object.keys(rows[0]);
  return '\ufeff' + [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
}
