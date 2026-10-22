export interface TweetRecord {
  id: string;
  account: string;        // the signed-in user's handle (lowercase) this record was captured for
  author: string;         // lowercase handle, no @
  name: string;
  text: string;
  time: number;           // ms epoch (from <time datetime>)
  replyTo: string[];      // lowercase handles this tweet replies to
  parentId?: string;      // tweet id this replies to, when known from the page structure
  convoId?: string;       // conversation root/focal tweet id when captured on a status page
  url: string;
  seenAt: number;
}

export interface UserCell {
  handle: string;
  name: string;
  followsYou: boolean;
}

export interface Snapshot {
  id?: number;
  account: string;
  kind: 'following' | 'followers';
  takenAt: number;
  complete: boolean;      // true when the list was scrolled to the end
  users: UserCell[];
}

export type PageKind = 'status' | 'notifications' | 'following' | 'followers' | 'profile' | 'other';

export interface PageInfo { kind: PageKind; handle?: string; statusId?: string }

export type Plan = 'free' | 'pro';
