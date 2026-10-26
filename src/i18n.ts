export type Lang = 'zh' | 'en';
const D = {
  title: ['X 互动名单助手', 'X Engagement List'],
  leaderboard: ['评论排行', 'Top commenters'],
  pending: ['待回复', 'To reply'],
  notBack: ['未回关', 'Not following back'],
  unfollowers: ['取关', 'Unfollowers'],
  settings: ['设置', 'Settings'],
  days: ['时间范围', 'Range'],
  d7: ['近 7 天', 'Last 7 days'], d30: ['近 30 天', 'Last 30 days'], d90: ['近 90 天', 'Last 90 days'],
  user: ['用户', 'User'], count: ['评论数', 'Comments'], last: ['最近一次', 'Latest'], open: ['打开', 'Open'],
  comment: ['评论内容', 'Comment'], time: ['时间', 'Time'], followsYou: ['关注你', 'Follows you'],
  exportCsv: ['导出 CSV', 'Export CSV'],
  empty: ['还没有数据。打开你帖子的详情页、通知页，或者你的关注/粉丝列表，助手会自动记录你屏幕上看到的内容。',
          'No data yet. Open your posts, your Notifications, or your Following/Followers list; the assistant records what you see on screen.'],
  noSnap: ['还没有完整的“关注”快照。打开你的“正在关注”页面，点右下角的“开始记录快照”。',
           'No complete Following snapshot yet. Open your Following page and click “Start snapshot” (bottom right).'],
  needTwo: ['需要至少两次完整的“粉丝”快照才能对比取关。打开你的粉丝页面，点右下角“开始记录快照”；过几天再记录一次。',
            'Unfollow detection needs two complete Followers snapshots. Open your Followers page, click “Start snapshot”, and repeat in a few days.'],
  lastSnap: ['快照时间', 'Snapshot taken'], removed: ['取关了你', 'Unfollowed you'], added: ['新关注你', 'New followers'],
  account: ['账号', 'Account'],
  wipe: ['删除这个账号的全部本地数据', 'Delete all local data for this account'], wiped: ['已删除', 'Deleted'],
  diag: ['诊断（页面结构检测）', 'Diagnostics (page structure check)'],
  privacy: ['所有数据只保存在你的浏览器本地，不上传任何服务器，扩展不发出任何网络请求。',
            'All data stays in your browser. Nothing is uploaded and the extension makes no network requests.'],
  privacyLink: ['隐私政策', 'Privacy policy'],
  more: ['显示更多', 'Show more'],
} as const;

export type Key = keyof typeof D;
export function t(lang: Lang, k: Key, vars: Record<string, string | number> = {}): string {
  let s: string = D[k][lang === 'zh' ? 0 : 1];
  for (const [a, b] of Object.entries(vars)) s = s.replace(`{${a}}`, String(b));
  return s;
}
export function defaultLang(): Lang {
  return (typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh')) ? 'zh' : 'en';
}
