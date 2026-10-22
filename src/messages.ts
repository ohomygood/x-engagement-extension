import type { Snapshot, TweetRecord } from './types';

export type Msg =
  | { type: 'tweets'; account: string; tweets: TweetRecord[] }
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'health'; account: string; url: string; health: Record<string, { matched: string | null; count: number }> };

const HANDLE = /^[a-z0-9_]{1,15}$/;

/** Defensive validation: the background only accepts well-formed messages from our own content script. */
export function validMsg(m: unknown): m is Msg {
  if (!m || typeof m !== 'object') return false;
  const x = m as Record<string, unknown>;
  if (x.type === 'tweets') {
    return typeof x.account === 'string' && HANDLE.test(x.account) && Array.isArray(x.tweets) && x.tweets.length <= 500 &&
      (x.tweets as TweetRecord[]).every((t) => typeof t.id === 'string' && /^\d+$/.test(t.id) && HANDLE.test(t.author) &&
        t.account === x.account && Array.isArray(t.replyTo) && typeof t.time === 'number');
  }
  if (x.type === 'snapshot') {
    const s = x.snapshot as Snapshot;
    return !!s && HANDLE.test(s.account) && (s.kind === 'following' || s.kind === 'followers') && Array.isArray(s.users) &&
      s.users.length <= 20000 && s.users.every((u) => HANDLE.test(u.handle));
  }
  if (x.type === 'health') return typeof x.account === 'string' && typeof x.health === 'object';
  return false;
}
