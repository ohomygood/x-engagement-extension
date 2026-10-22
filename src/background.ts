/** MV3 service worker: the only writer to IndexedDB. Receives parsed data from the content script. */
import { accounts, addSnapshot, putTweets, rememberAccount, setMeta } from './db';
import { validMsg } from './messages';
import { currentPlan } from './plan';

async function accountAllowed(account: string): Promise<boolean> {
  const list = await accounts();
  if (list.includes(account) || list.length === 0) return true;
  return (await currentPlan()) === 'pro'; // multi-account is a Pro feature
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !validMsg(msg)) { sendResponse({ ok: false }); return false; }
  (async () => {
    if (msg.type === 'health') {
      await setMeta('health', { ...msg, at: Date.now() });
      return { ok: true };
    }
    const account = msg.type === 'tweets' ? msg.account : msg.snapshot.account;
    if (!(await accountAllowed(account))) return { ok: false, reason: 'pro-required-for-multi-account' };
    await rememberAccount(account);
    if (msg.type === 'tweets') return { ok: true, added: await putTweets(msg.tweets) };
    return { ok: true, id: await addSnapshot(msg.snapshot) };
  })().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
  return true; // async response
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});
