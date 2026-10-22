// Minimal reproductions of x.com markup (Oct 2026): data-testid hooks, <time datetime>, "Replying to" blocks,
// UserCell with userFollowIndicator. Used by unit tests (jsdom) and the Chrome E2E suite.
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function tweet({ handle, name, id, time, text, replyTo = [], repostBy = null, promoted = false }) {
  const ctx = repostBy ? `<div data-testid="socialContext"><span>${esc(repostBy)} reposted</span></div>` : '';
  const reply = replyTo.length
    ? `<div dir="ltr">Replying to ${replyTo.map((h) => `<div><a href="/${h}" role="link">@${h}</a></div>`).join(' and ')}</div>` : '';
  const timeLink = promoted ? '<span>Ad</span>'
    : `<a href="/${handle}/status/${id}" role="link"><time datetime="${new Date(time).toISOString()}">x</time></a>`;
  return `<div data-testid="cellInnerDiv"><article data-testid="tweet" role="article" tabindex="0">${ctx}
    <div><div data-testid="User-Name"><div><a href="/${handle}" role="link"><div><span>${esc(name)}</span></div></a></div>
    <div><a href="/${handle}" role="link" tabindex="-1"><span>@${handle}</span></a><span>·</span>${timeLink}</div></div>
    ${reply}<div data-testid="tweetText" lang="en" dir="auto"><span>${esc(text)}</span></div>
    <div role="group"><button data-testid="reply"></button><button data-testid="like"></button></div></div></article></div>`;
}

export function userCell({ handle, name, followsYou = false }) {
  return `<div data-testid="cellInnerDiv"><button data-testid="UserCell" role="button"><div>
    <a href="/${handle}" role="link"><img alt=""></a><div><a href="/${handle}" role="link"><span>${esc(name)}</span></a>
    <div><a href="/${handle}" role="link" tabindex="-1"><span>@${handle}</span></a>
    ${followsYou ? '<div data-testid="userFollowIndicator"><span>Follows you</span></div>' : ''}</div></div>
    <div><button data-testid="${handle}-unfollow"><span>Following</span></button></div></div></button></div>`;
}

export function page({ me, title = 'X', body, script = '' }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>
  <div id="react-root"><header role="banner"><nav role="navigation"><a href="/home" data-testid="AppTabBar_Home_Link">Home</a>
  <a href="/notifications">Notifications</a><a href="/${me}" data-testid="AppTabBar_Profile_Link" aria-label="Profile">Profile</a></nav></header>
  <main role="main"><div data-testid="primaryColumn"><section role="region"><div aria-label="Timeline">${body}</div></section></div></main></div>
  ${script ? `<script>${script}</script>` : ''}</body></html>`;
}

const NOW0 = Date.parse('2026-10-22T02:00:00Z');
const NOW = NOW0;
const H = 3600_000, D = 24 * H;
export { NOW };

/** Status page for @me's post 100 with 6 replies: alice x2 (one answered by me), bob, carol (old), a reply-to-other, an ad. */
export function statusPage(me = 'me', NOW = NOW0) {
  return page({ me, title: 'Post', body: [
    tweet({ handle: me, name: 'Me', id: '100', time: NOW - 2 * D, text: 'Launching my store today!' }),
    tweet({ handle: 'alice', name: 'Alice', id: '101', time: NOW - 47 * H, text: 'Congrats! Ships to HK?' }),
    tweet({ handle: me, name: 'Me', id: '102', time: NOW - 46 * H, text: '@alice yes we do', replyTo: ['alice'] }),
    tweet({ handle: 'bob', name: 'Bob', id: '103', time: NOW - 40 * H, text: '=HYPERLINK("x") nice', replyTo: [me] }),
    tweet({ handle: 'alice', name: 'Alice', id: '104', time: NOW - 30 * H, text: 'Ordered one 🎉' }),
    tweet({ handle: 'dave', name: 'Dave', id: '105', time: NOW - 20 * H, text: '@bob agreed', replyTo: ['bob'] }),
    tweet({ handle: 'spam', name: 'Promo', id: '0', time: NOW, text: 'Buy now', promoted: true }),
  ].join('') });
}

export function notificationsPage(me = 'me', NOW = NOW0) {
  return page({ me, title: 'Notifications', body: [
    tweet({ handle: 'carol', name: 'Carol', id: '201', time: NOW - 10 * D, text: 'Old comment', replyTo: [me] }),
    tweet({ handle: 'erin', name: 'Erin', id: '202', time: NOW - 3 * H, text: 'Love this', replyTo: [me] }),
    tweet({ handle: 'erin', name: 'Erin', id: '203', time: NOW - 2 * H, text: 'Reposted', repostBy: 'Frank' }),
  ].join('') });
}

/** Following list: n users, every 3rd follows back. With `lazy`, cells load as you scroll and old ones are removed (like X). */
export function followingPage(me = 'me', n = 60, lazy = false, kind = 'following') {
  const users = Array.from({ length: n }, (_, i) => ({ handle: `user${i}`, name: `User ${i}`, followsYou: i % 3 === 0 }));
  if (!lazy) return page({ me, title: kind, body: users.map(userCell).join('') });
  const script = `const U=${JSON.stringify(users)};const tl=document.querySelector('[aria-label=Timeline]');let next=0;
    const cell=${userCell.toString()};const esc=${esc.toString()};
    function more(k){for(let i=0;i<k&&next<U.length;i++,next++){tl.insertAdjacentHTML('beforeend',cell(U[next]).replace('<div ','<div style="height:72px" '));}
      const cells=tl.querySelectorAll('[data-testid=cellInnerDiv]');if(cells.length>30){for(let i=0;i<cells.length-30;i++){const h=cells[i].offsetHeight;cells[i].remove();tl.style.paddingTop=(parseInt(tl.style.paddingTop||0)+h)+'px';}}}
    more(15);addEventListener('scroll',()=>{if(innerHeight+scrollY>=document.documentElement.scrollHeight-200)setTimeout(()=>more(8),200)});`;
  return page({ me, title: kind, body: '', script });
}

/** Stress page: @me's post with `n` replies from n/3 distinct users (for the 1,000-record acceptance check). */
export function bigThreadPage(me = 'me', n = 1000, NOW = NOW0) {
  const items = [tweet({ handle: me, name: 'Me', id: '5000', time: NOW - 3 * D, text: 'Big thread' })];
  for (let i = 0; i < n; i++) items.push(tweet({ handle: `fan${i % Math.ceil(n / 3)}`, name: `Fan ${i % Math.ceil(n / 3)}`,
    id: String(6000 + i), time: NOW - 3 * D + (i + 1) * 60_000, text: `Reply number ${i}`, replyTo: [me] }));
  return page({ me, title: 'Big thread', body: items.join('') });
}

/** Followers list as a lazily loading page; `users` = explicit list of {handle,name,followsYou}. */
export function lazyListPage(me, users, kind = 'followers') {
  const script = `const U=${JSON.stringify(users)};const tl=document.querySelector('[aria-label=Timeline]');let next=0;
    const cell=${userCell.toString()};const esc=${esc.toString()};
    function more(k){for(let i=0;i<k&&next<U.length;i++,next++){tl.insertAdjacentHTML('beforeend',cell(U[next]).replace('<div ','<div style="height:72px" '));}
      const cells=tl.querySelectorAll('[data-testid=cellInnerDiv]');if(cells.length>30){for(let i=0;i<cells.length-30;i++){const h=cells[i].offsetHeight;cells[i].remove();tl.style.paddingTop=(parseInt(tl.style.paddingTop||0)+h)+'px';}}}
    more(15);addEventListener('scroll',()=>{if(innerHeight+scrollY>=document.documentElement.scrollHeight-200)setTimeout(()=>more(8),200)});`;
  return page({ me, title: kind, body: '', script });
}
