# 👻 Ghostlist

A Chrome extension that **lists the inactive ("ghost") accounts you follow on X/Twitter** — accounts that haven't posted in 6 or 12+ months — so you can review and unfollow them yourself.

**Ghostlist is read-only. It never unfollows anyone for you.** It scans your Following list, shows you who's gone quiet, and gives you one-click links to each profile so *you* decide. Think of it as a triage dashboard, not a mass-unfollow button.

---

## Why read-only?

The thing X actually polices is *automated* actions (scripted bulk unfollowing). Ghostlist deliberately doesn't do that. It only **reads** your own following list — the same data your timeline already shows you — and reports it. You do the unfollowing by hand, like any normal user. That keeps the tool firmly on the safe side of X's automation rules and avoids putting your account at risk.

It's still an unofficial tool that reads X via the page you're logged into. Use it on your own account, at your own discretion. Not affiliated with or endorsed by X Corp.

---

## Install (load unpacked)

Ghostlist isn't on the Chrome Web Store yet. To run it now:

1. Clone or download this repo.
2. Go to `chrome://extensions`.
3. Toggle **Developer mode** on (top-right).
4. Click **Load unpacked** and select the **`src/`** folder of this repo.
5. The 👻 icon appears in your toolbar. Pin it.

## Use

1. On X, open **your own profile → Following** (URL ends in `/following`).
2. Click the 👻 Ghostlist icon.
3. Pick a threshold — **6+** or **12+ months**.
4. Click **Scan my Following list** and leave the tab open. Ghostlist scrolls your following list and checks recent activity.
5. When it finishes, a results page opens: a sortable, searchable table of inactive accounts. Click any handle to open the profile and unfollow manually. Check accounts off as you go (saved locally), or **Export CSV**.

---

## ☑️ Morning / first-run verification checklist

Ghostlist relies on X's internal page structure, which X changes without notice. The parsing **logic** is covered by 30 unit/integration tests (`npm test`), but the **live selectors and network shapes** must be confirmed against the real site. When you first load it:

- [ ] **Following list populates.** Start a scan on your Following page; the popup should count up ("Found N accounts…"). If it stays at 0, the `Following` GraphQL response shape or the auto-scroll trigger needs adjusting — capture a real response (DevTools → Network → filter `Following`) and compare against `test/fixtures/following-legacy.json`.
- [ ] **Activity resolves.** During the "Checking activity" phase, accounts should get last-post dates. If everything lands in **Unknown**, the `UserTweets` replay isn't returning data — check the console for the replay status, and confirm the captured request template (see `src/inject/inject.js`) carries valid auth headers.
- [ ] **DOM fallback selectors.** If you'd rather not rely on response interception, drop a real Following-page HTML snapshot into `test/fixtures/following-page.html` (DevTools → Elements → copy a `UserCell` container's outerHTML) and run `npm test` to confirm `dom-following.js` still matches.
- [ ] **Classification looks right.** Spot-check a few "ghosts" — are they genuinely dormant past your threshold? Pinned-but-old accounts should *not* be flagged active (we ignore pinned posts).

Anything off in the live selectors is a small, localized fix — the architecture isolates it to `src/lib/parse-*.js` / `src/lib/dom-following.js`, all fixture-tested.

---

## How it works

```
popup ── start ──▶ content script ──▶ injects inject.js (page context)
                        │                     │
                        │   auto-scrolls      ├─ tees X's own GraphQL responses
                        │   Following list    │   (Following, UserTweets) back
                        │                     └─ replays UserTweets per-user using
                        │                        X's real auth context (no forged
                        ▼                        signed requests)
              classify vs threshold ──▶ chrome.storage ──▶ results page
```

- **`src/lib/`** — pure, dependency-free, fully tested logic: `parse-following.js`, `parse-tweets.js`, `x-user.js` (handles X's `legacy`→`core` field migration), `activity.js` (threshold classification), `dom-following.js` (DOM fallback), `csv.js`.
- **`src/inject/inject.js`** — page-context interceptor. Borrows the page's authenticated requests rather than reconstructing them.
- **`src/content/content.js`** — orchestrates the scan.
- **`src/background/background.js`** — opens the results tab.
- **`src/popup/`**, **`src/results/`** — UI. User data is rendered with `textContent`/DOM methods (no `innerHTML`), so a malicious display name can't inject markup.

### "Inactive" definition

The most recent **visible post or repost** on the profile, **ignoring pinned posts** (a pinned old post shouldn't make a dormant account look active). Replies aren't counted. Protected accounts can't be read and are listed as **Unknown** — never as inactive. Accounts that provably never posted are flagged as ghosts. When activity genuinely can't be determined, the account is **Unknown**, not inactive — Ghostlist errs toward never nudging you on bad data.

---

## Develop

```bash
npm install      # installs linkedom (dev-only, for DOM tests)
npm test         # 30 node:test unit + integration tests, no browser needed
npm run zip      # package src/ into ghostlist.zip for distribution
```

There is **no build step** — the extension ships the `src/` folder as-is (ES modules, dynamic imports). Edit and reload.

Contributions welcome, especially keeping the X selectors/response shapes current. PRs that add a real (anonymized) fixture for a shape that broke are the most valuable kind.

---

## Limitations & honesty

- X changes its internal API/DOM frequently; expect occasional breakage. The tests make fixes localized.
- Activity resolution for large following counts is rate-limited on purpose (gentle, sequential) and can take a while.
- Last-*visible*-post is an approximation of "active" — someone who only lurks/likes/replies may show as inactive.
- This reads X through your logged-in session. It's an unofficial tool; use it responsibly on your own account.

## License

[MIT](LICENSE) © 2026 nolandruid
