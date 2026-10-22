/** IndexedDB storage (extension origin only: called from the background worker and extension pages). */
import type { Snapshot, TweetRecord } from './types';

const DB_NAME = 'x-engagement';
const VERSION = 1;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

let dbp: Promise<IDBDatabase> | null = null;
export function openDB(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      const t = db.createObjectStore('tweets', { keyPath: ['account', 'id'] });
      t.createIndex('account', 'account');
      const s = db.createObjectStore('snapshots', { keyPath: 'id', autoIncrement: true });
      s.createIndex('account', 'account');
      db.createObjectStore('meta');
    };
    r.onsuccess = () => { const db = r.result; db.onversionchange = () => { db.close(); dbp = null; }; res(db); };
    r.onerror = () => { dbp = null; rej(r.error); };
  });
  return dbp;
}

export async function _resetForTests() {
  if (dbp) { try { (await dbp).close(); } catch { /* ignore */ } }
  dbp = null;
  await new Promise<void>((res) => { const r = indexedDB.deleteDatabase(DB_NAME); r.onsuccess = r.onerror = r.onblocked = () => res(); });
}

export async function putTweets(tweets: TweetRecord[]): Promise<number> {
  if (!tweets.length) return 0;
  const db = await openDB();
  const tx = db.transaction('tweets', 'readwrite');
  const st = tx.objectStore('tweets');
  let added = 0;
  for (const t of tweets) {
    const existing = await req(st.get([t.account, t.id])) as TweetRecord | undefined;
    if (!existing) added++;
    // keep the richest version: preserve inferred parent/convo info if a later view lacks it
    st.put(existing ? { ...existing, ...t, parentId: t.parentId ?? existing.parentId, convoId: t.convoId ?? existing.convoId,
                        replyTo: t.replyTo.length ? t.replyTo : existing.replyTo, seenAt: existing.seenAt } : t);
  }
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  return added;
}

export async function getTweets(account: string): Promise<TweetRecord[]> {
  const db = await openDB();
  return req(db.transaction('tweets').objectStore('tweets').index('account').getAll(account)) as Promise<TweetRecord[]>;
}

export async function addSnapshot(s: Snapshot): Promise<number> {
  const db = await openDB();
  return req(db.transaction('snapshots', 'readwrite').objectStore('snapshots').add(s)) as Promise<number>;
}

export async function getSnapshots(account: string): Promise<Snapshot[]> {
  const db = await openDB();
  return req(db.transaction('snapshots').objectStore('snapshots').index('account').getAll(account)) as Promise<Snapshot[]>;
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const db = await openDB();
  return req(db.transaction('meta').objectStore('meta').get(key)) as Promise<T | undefined>;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  const db = await openDB();
  await req(db.transaction('meta', 'readwrite').objectStore('meta').put(value, key));
}

export async function accounts(): Promise<string[]> {
  return (await getMeta<string[]>('accounts')) || [];
}

export async function rememberAccount(a: string): Promise<void> {
  const list = await accounts();
  if (!list.includes(a)) await setMeta('accounts', [...list, a]);
}

/** Delete everything for one account (user-initiated from Settings). */
export async function wipeAccount(account: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(['tweets', 'snapshots'], 'readwrite');
  for (const name of ['tweets', 'snapshots'] as const) {
    const st = tx.objectStore(name);
    const keys = await req(st.index('account').getAllKeys(account));
    for (const k of keys) st.delete(k);
  }
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  await setMeta('accounts', (await accounts()).filter((x) => x !== account));
}
