/** MV3 service worker: the only writer to IndexedDB. Receives parsed data from the content script. */
import { addSnapshot, putTweets, rememberAccount, setMeta } from './db';
import { validMsg } from './messages';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !validMsg(msg)) { sendResponse({ ok: false }); return false; }
  (async () => {
    if (msg.type === 'health') {
      await setMeta('health', { ...msg, at: Date.now() });
      return { ok: true };
    }
    const account = msg.type === 'tweets' ? msg.account : msg.snapshot.account;
    await rememberAccount(account);
    if (msg.type === 'tweets') return { ok: true, added: await putTweets(msg.tweets) };
    return { ok: true, id: await addSnapshot(msg.snapshot) };
  })().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
  return true; // async response
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});
