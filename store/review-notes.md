# Chrome Web Store review notes

**Single purpose:** Help a user see engagement on their own X account (who comments, which comments are unanswered, who doesn't follow back / unfollowed) from pages they view, stored locally.

**Permissions requested:** none. `permissions: []`, no `host_permissions`.
- Content script on `https://x.com/*` only: needed to read the posts/lists the user is viewing. It does not inject UI except a small Shadow-DOM panel on the user's OWN Following/Followers pages (the snapshot button).
- No `storage` permission: data lives in IndexedDB of the extension origin (written by the service worker).
- No `tabs`: the toolbar button opens `dashboard.html` with `chrome.tabs.create`, which needs no permission.
- License check uses `fetch` to our Worker, which answers with CORS; no host permission needed.

**Remote code:** none. All JS is bundled; CSP `script-src 'self'`.

**Data use disclosures (Privacy practices tab):**
- Collects: "Website content" (posts/handles on x.com) — stored locally only, not transmitted.
- Collects for Pro: license key + random device ID → license server (functionality only).
- Certify: not sold, not used for unrelated purposes, not used for creditworthiness.

**Automation:** none of follow/unfollow/like/reply/DM. The only scripted behaviour is the user-started, user-stoppable scroll on the user's own Following/Followers page (≈0.85 screen every 1.5–2.5 s).

**Trademark note:** listing says "for X" descriptively and "Not affiliated with X Corp."; icon contains no X logo. If review objects to "X" in the name, fallback name: "Engagement List — commenters & follow-back checker".

**Test instructions for reviewers:** sign in to x.com, open one of your posts with replies, then click the toolbar icon → dashboard → "Top commenters". Open x.com/<you>/following → panel bottom-right → "Start snapshot".
