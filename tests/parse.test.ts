import { detectMe, detectPage, parsePage, parseUserCells } from '../src/parse';
import { selectorHealth } from '../src/selectors';
// @ts-expect-error untyped fixture module
import { followingPage, notificationsPage, statusPage, page, NOW } from './fixtures/xdom.mjs';

const dom = (html: string) => new DOMParser().parseFromString(html, 'text/html');

describe('detectPage', () => {
  it('classifies x.com URLs', () => {
    expect(detectPage('https://x.com/Me/status/123')).toEqual({ kind: 'status', handle: 'me', statusId: '123' });
    expect(detectPage('https://x.com/notifications/mentions').kind).toBe('notifications');
    expect(detectPage('https://x.com/me/following')).toEqual({ kind: 'following', handle: 'me' });
    expect(detectPage('https://x.com/me/verified_followers').kind).toBe('followers');
    expect(detectPage('https://x.com/home').kind).toBe('other');
    expect(detectPage('https://x.com/settings/account').kind).toBe('other');
  });
});

describe('parsing', () => {
  it('finds the signed-in user', () => {
    expect(detectMe(dom(statusPage('Me_Handle')))).toBe('me_handle');
    expect(detectMe(dom('<html><body>logged out</body></html>'))).toBeNull();
  });

  it('parses a status page with inferred reply targets and skips ads', () => {
    const ts = parsePage(dom(statusPage()), 'https://x.com/me/status/100', 'me', NOW);
    expect(ts.map((t) => t.id)).toEqual(['100', '101', '102', '103', '104', '105']);
    const by = Object.fromEntries(ts.map((t) => [t.id, t]));
    expect(by['101'].replyTo).toEqual(['me']);           // no "Replying to" line -> focal author
    expect(by['101'].parentId).toBe('100');
    expect(by['102'].replyTo).toEqual(['alice']);
    expect(by['102'].parentId).toBe('101');              // replies to previous tweet's author
    expect(by['105'].replyTo).toEqual(['bob']);
    expect(by['103'].convoId).toBe('100');
    expect(by['101'].time).toBe(NOW - 47 * 3600_000);
    expect(by['101'].name).toBe('Alice');
    expect(by['101'].url).toBe('https://x.com/alice/status/101');
  });

  it('parses notifications and skips reposts', () => {
    const ts = parsePage(dom(notificationsPage()), 'https://x.com/notifications', 'me', NOW);
    expect(ts.map((t) => t.id)).toEqual(['201', '202']);
    expect(ts[1].replyTo).toEqual(['me']);
  });

  it('parses user cells with follows-you indicator', () => {
    const us = parseUserCells(dom(followingPage('me', 9)));
    expect(us).toHaveLength(9);
    expect(us.filter((u) => u.followsYou).map((u) => u.handle)).toEqual(['user0', 'user3', 'user6']);
    expect(us[1]).toEqual({ handle: 'user1', name: 'User 1', followsYou: false });
  });

  it('falls back to text when the follow indicator test id disappears', () => {
    const html = followingPage('me', 3).replace(/data-testid="userFollowIndicator"/g, 'class="x"');
    expect(parseUserCells(dom(html)).filter((u) => u.followsYou).map((u) => u.handle)).toEqual(['user0']);
  });

  it('falls back to article[role=article] when data-testid="tweet" changes', () => {
    const html = statusPage().replace(/data-testid="tweet"/g, 'data-testid="post"');
    expect(parsePage(dom(html), 'https://x.com/me/status/100', 'me', NOW)).toHaveLength(6);
  });

  it('reports selector health', () => {
    const h = selectorHealth(dom(statusPage()));
    expect(h.tweet.count).toBe(7);
    expect(h.profileNav.matched).toContain('AppTabBar_Profile_Link');
    expect(h.userCell.count).toBe(0);
  });

  it('handles Chinese UI text', () => {
    const html = page({ me: 'me', body: followingPage('me', 2).match(/<div data-testid="cellInnerDiv">[\s\S]*$/)![0] })
      .replace(/data-testid="userFollowIndicator"><span>Follows you/g, 'class="y"><span>关注了你');
    expect(parseUserCells(dom(html))[0].followsYou).toBe(true);
  });
});
