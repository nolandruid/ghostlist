// Content script (isolated world). Orchestrates a scan:
//   1. Inject the page-context interceptor (inject.js).
//   2. Auto-scroll the Following list; collect users from intercepted responses.
//   3. Resolve last-activity (inline status if present, else replay UserTweets).
//   4. Classify against the chosen threshold, persist results, open the results page.
//
// Classic script (no static imports) so it loads as a content script; the tested
// libs are pulled in lazily via dynamic import() of web-accessible module URLs.

(() => {
  const TAG = 'ghostlist';
  if (window.__ghostlistLoaded) return;
  window.__ghostlistLoaded = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (base) => base + Math.floor(Math.random() * base * 0.4);
  const log = (...args) => console.log('%c[ghostlist]', 'color:#1d9bf0;font-weight:bold', ...args);

  // ---- page-context bridge --------------------------------------------------
  const pending = new Map(); // reqId -> resolve
  let reqSeq = 0;
  const followingResponses = []; // raw JSON strings of Following responses
  const tweetResponses = new Map(); // userId -> raw JSON string (from replay)

  function injectInterceptor() {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('inject/inject.js');
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.source !== TAG) return;
    if (d.kind === 'response' && d.op === 'Following') {
      followingResponses.push(d.body);
    } else if (d.kind === 'replayResult' || d.kind === 'capabilities' || d.kind === 'templateLoaded') {
      const resolve = pending.get(d.reqId);
      if (resolve) { pending.delete(d.reqId); resolve(d); }
    } else if (d.kind === 'template' && d.op) {
      // Persist captured templates so a future scan works without re-visiting a
      // profile. We only need UserTweets (auth headers refresh live each scan).
      if (d.op === 'UserTweets') {
        chrome.storage.local.set({
          ghostlistTpl_UserTweets: { url: d.url, headers: d.headers, method: d.method, savedAt: Date.now() },
        });
      }
    }
  });

  function sendCmd(kind, extra = {}) {
    const reqId = `r${++reqSeq}`;
    return new Promise((resolve) => {
      pending.set(reqId, resolve);
      window.postMessage({ source: `${TAG}-cmd`, kind, reqId, ...extra }, window.location.origin);
      // Safety timeout so a lost message never hangs the scan.
      setTimeout(() => {
        if (pending.has(reqId)) { pending.delete(reqId); resolve({ timeout: true }); }
      }, 15000);
    });
  }

  // ---- progress reporting ---------------------------------------------------
  function progress(patch) {
    const msg = { type: 'GHOSTLIST_PROGRESS', ...patch };
    chrome.runtime.sendMessage(msg).catch(() => {});
    chrome.storage.local.set({ ghostlistProgress: { ...patch, at: Date.now() } });
  }

  // ---- scan -----------------------------------------------------------------
  let scanning = false;

  async function runScan({ thresholdMonths }) {
    if (scanning) return;
    scanning = true;
    log(`scan started — threshold ${thresholdMonths}+ months, url=${location.href}`);
    try {
      const libBase = (p) => chrome.runtime.getURL(`lib/${p}`);
      const { parseFollowing } = await import(libBase('parse-following.js'));
      const { parseLatestActivity } = await import(libBase('parse-tweets.js'));
      const { classifyAll } = await import(libBase('activity.js'));

      progress({ phase: 'collecting', found: 0, message: 'Loading your following list…' });

      // --- collect following via auto-scroll + interception ---
      const byId = new Map();
      const mergeFromBuffer = () => {
        while (followingResponses.length) {
          const body = followingResponses.shift();
          try {
            const { users } = parseFollowing(JSON.parse(body));
            for (const u of users) if (u.restId) byId.set(u.restId, u);
          } catch (_) { /* skip malformed */ }
        }
      };

      let stagnant = 0;
      let lastCount = 0;
      const MAX_SCROLLS = 600; // hard cap (~ tens of thousands of follows)
      for (let i = 0; i < MAX_SCROLLS; i++) {
        window.scrollTo(0, document.documentElement.scrollHeight);
        await sleep(jitter(900));
        mergeFromBuffer();
        const count = byId.size;
        progress({ phase: 'collecting', found: count, message: `Found ${count} accounts…` });
        if (count === lastCount) {
          stagnant++;
          if (stagnant >= 4) break; // 4 quiet rounds => list exhausted
        } else {
          stagnant = 0;
          lastCount = count;
        }
      }
      mergeFromBuffer();

      const accounts = [...byId.values()];
      if (accounts.length === 0) {
        progress({ phase: 'error', message: 'No follows captured. Are you on your own Following page?' });
        return;
      }

      const withInline = accounts.filter((a) => a.lastActivityAt).length;
      log(`collected ${accounts.length} accounts; ${withInline} had inline activity`);

      // --- resolve activity for accounts without inline status ---
      let caps = await sendCmd('capabilities');
      let canReplay = Array.isArray(caps.ops) && caps.ops.includes('UserTweets');
      log(`capabilities: templates=[${(caps.ops || []).join(', ') || 'none'}] canReplay=${canReplay} hasAuth=${caps.hasAuth}`);

      // If no live UserTweets template, try a persisted one from a past session.
      if (!canReplay) {
        const saved = (await chrome.storage.local.get('ghostlistTpl_UserTweets')).ghostlistTpl_UserTweets;
        if (saved && saved.url) {
          log(`no live template; restoring saved UserTweets template (saved ${new Date(saved.savedAt).toLocaleString()})`);
          await sendCmd('loadTemplate', { op: 'UserTweets', template: { url: saved.url, headers: saved.headers, method: saved.method } });
          caps = await sendCmd('capabilities');
          canReplay = Array.isArray(caps.ops) && caps.ops.includes('UserTweets');
          log(`after restore: canReplay=${canReplay}`);
        }
      }

      const needActivity = accounts.filter(
        (a) => !a.lastActivityAt && !a.protectedAccount && a.statusesCount !== 0
      );
      log(`${needActivity.length} accounts need an activity lookup`);

      if (!canReplay && needActivity.length) {
        log('NO UserTweets template (live or saved). Open ANY profile once so X issues a UserTweets request, then rescan — it will be remembered from now on.');
        progress({ phase: 'activity', message: 'Open any profile once, then rescan (see console). Listing what we know.' });
      }

      if (canReplay && needActivity.length) {
        let ok = 0;
        let failed = 0;
        for (let i = 0; i < needActivity.length; i++) {
          const a = needActivity[i];
          progress({
            phase: 'activity',
            found: accounts.length,
            resolved: i,
            total: needActivity.length,
            message: `Checking activity ${i + 1}/${needActivity.length}…`,
          });
          let res = await sendCmd('replayUserTweets', { userId: a.restId, count: 20 });
          // Rate-limited? Back off progressively and retry a couple of times.
          let backoff = 0;
          while (res && res.status === 429 && backoff < 3) {
            const wait = 15000 * (backoff + 1);
            log(`rate-limited (429); backing off ${wait / 1000}s then retrying @${a.handle}`);
            progress({ phase: 'activity', found: accounts.length, resolved: i, total: needActivity.length, message: `Rate-limited — pausing ${wait / 1000}s…` });
            await sleep(wait);
            res = await sendCmd('replayUserTweets', { userId: a.restId, count: 20 });
            backoff++;
          }
          if (res && res.body) {
            try {
              const json = JSON.parse(res.body);
              const at = parseLatestActivity(json);
              a.lastActivityAt = at;
              if (at) ok++; else failed++;
              if (i < 3) {
                // Loud diagnostics for the first few so we can see X's actual reply.
                log(`replay @${a.handle} (id ${a.restId}): http=${res.status} parsedActivity=${at || 'null'}`);
                if (json && json.errors) log(`  X returned errors: ${JSON.stringify(json.errors).slice(0, 300)}`);
              }
            } catch (e) {
              failed++;
              if (i < 3) log(`replay @${a.handle}: body not JSON / parse error: ${e.message}; status=${res.status}; head=${String(res.body).slice(0, 120)}`);
            }
          } else {
            failed++;
            if (i < 3) log(`replay @${a.handle}: no body (error=${res && res.error}, timeout=${res && res.timeout}, status=${res && res.status})`);
          }
          await sleep(jitter(1100)); // be gentle on rate limits
        }
        log(`activity resolution done: ${ok} resolved, ${failed} failed/empty`);
      }

      // --- classify + persist ---
      const buckets = classifyAll(accounts, { thresholdMonths, now: Date.now() });
      const result = {
        thresholdMonths,
        scannedAt: Date.now(),
        counts: {
          total: accounts.length,
          inactive: buckets.inactive.length,
          active: buckets.active.length,
          unknown: buckets.unknown.length,
        },
        inactive: buckets.inactive,
        unknown: buckets.unknown,
      };
      await chrome.storage.local.set({ ghostlistResult: result });
      log(`done — inactive=${result.counts.inactive} active=${result.counts.active} unknown=${result.counts.unknown} total=${result.counts.total}`);
      progress({ phase: 'done', ...result.counts });
      chrome.runtime.sendMessage({ type: 'GHOSTLIST_OPEN_RESULTS' }).catch(() => {});
    } catch (err) {
      progress({ phase: 'error', message: String(err && err.message || err) });
    } finally {
      scanning = false;
    }
  }

  // ---- message handlers -----------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'GHOSTLIST_START') {
      runScan({ thresholdMonths: msg.thresholdMonths || 6 });
      sendResponse({ ok: true });
      return true;
    }
    if (msg && msg.type === 'GHOSTLIST_PING') {
      sendResponse({ ok: true, url: location.href });
      return true;
    }
  });

  injectInterceptor();
})();
