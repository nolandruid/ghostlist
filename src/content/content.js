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
    } else if (d.kind === 'replayResult' || d.kind === 'capabilities' || d.kind === 'templateLoaded' || d.kind === 'batchResult') {
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
  let cancelRequested = false;

  async function runScan({ thresholdMonths }) {
    if (scanning) return;
    scanning = true;
    cancelRequested = false;
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
        if (cancelRequested) { log('cancelled during collection'); break; }
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

      // Apply the persistent activity cache so we never re-fetch a resolved
      // account (key present => resolved, value may be null = "no recent posts").
      const cache = (await chrome.storage.local.get('ghostlistActivity')).ghostlistActivity || {};
      let cachedApplied = 0;
      for (const a of accounts) {
        if (!a.lastActivityAt && Object.prototype.hasOwnProperty.call(cache, a.restId)) {
          a.lastActivityAt = cache[a.restId];
          cachedApplied++;
        }
      }
      log(`applied ${cachedApplied} cached activity results from previous runs`);

      const stillNeeds = (a) => !a.lastActivityAt && !a.protectedAccount && a.statusesCount !== 0 &&
        !Object.prototype.hasOwnProperty.call(cache, a.restId);
      let needActivity = accounts.filter(stillNeeds);
      log(`${needActivity.length} accounts still need an activity lookup`);

      // --- FAST PATH: batch users/lookup (up to 100 accounts per call) ---
      // Resolves last-activity ~100x more efficiently than per-user UserTweets.
      // If the endpoint is unavailable for this session, we fall back below.
      if (needActivity.length && caps.hasAuth) {
        const { parseUsersLookup } = await import(libBase('parse-users-lookup.js'));
        const chunks = [];
        for (let i = 0; i < needActivity.length; i += 100) chunks.push(needActivity.slice(i, i + 100));
        let resolved = 0, pendingSave = 0, rateReset = null, batchOk = true;

        for (let c = 0; c < chunks.length; c++) {
          if (cancelRequested) { batchOk = false; break; }
          const chunk = chunks[c];
          progress({ phase: 'activity', found: accounts.length, resolved, total: needActivity.length,
            message: `Fast batch lookup ${c + 1}/${chunks.length} (100 at a time)…` });

          let res = await sendCmd('batchUsersLookup', { userIds: chunk.map((a) => a.restId) });
          if (res && res.reset != null) rateReset = res.reset;
          let tries = 0;
          while (res && res.status === 429 && tries < 4) {
            const ms = rateReset ? rateReset * 1000 - Date.now() : 60000;
            const wait = Math.min(Math.max(ms, 5000) + 2000, 16 * 60 * 1000);
            log(`batch rate-limited; waiting ${Math.ceil(wait / 1000)}s for reset`);
            progress({ phase: 'activity', found: accounts.length, resolved, total: needActivity.length, paused: true, message: `Rate limit — pausing ${Math.ceil(wait / 1000)}s…` });
            const until = Date.now() + wait;
            while (Date.now() < until && !cancelRequested) await sleep(1000);
            res = await sendCmd('batchUsersLookup', { userIds: chunk.map((a) => a.restId) });
            if (res && res.reset != null) rateReset = res.reset;
            tries++;
          }

          if (!res || res.status !== 200 || !res.body) {
            log(`batch users/lookup unavailable (status=${res && res.status}, error=${res && res.error}); falling back to per-account method`);
            batchOk = false;
            break;
          }
          let map;
          try { map = parseUsersLookup(JSON.parse(res.body)); }
          catch (e) { log(`batch parse error: ${e.message}; falling back`); batchOk = false; break; }

          for (const a of chunk) {
            if (Object.prototype.hasOwnProperty.call(map, a.restId)) {
              a.lastActivityAt = map[a.restId];
              cache[a.restId] = map[a.restId];
              resolved++; pendingSave++;
            }
          }
          if (c === 0) log(`✅ batch users/lookup works — resolved ${resolved} in ONE call (${chunks.length} calls will cover all ${needActivity.length})`);
          if (pendingSave >= 200) { await chrome.storage.local.set({ ghostlistActivity: cache }); pendingSave = 0; }
          await sleep(jitter(500));
        }
        await chrome.storage.local.set({ ghostlistActivity: cache });
        if (resolved) log(`batch resolution: ${resolved} accounts resolved via users/lookup`);
        needActivity = accounts.filter(stillNeeds); // leftovers for the fallback
        log(`${needActivity.length} accounts remain after batch`);
      }

      if (!canReplay && needActivity.length) {
        log('NO UserTweets template (live or saved). Open ANY profile once so X issues a UserTweets request, then rescan — it will be remembered from now on.');
        progress({ phase: 'activity', message: 'Open any profile once, then rescan (see console). Listing what we know.' });
      }

      if (canReplay && needActivity.length) {
        // One run targets roughly a single rate window so it finishes in minutes;
        // progress is cached, so re-running continues where this left off.
        const MAX_PER_RUN = 400;
        const BASE_PACE = 800;       // ms between successful calls
        const HARD_WAIT_CAP = 16 * 60 * 1000;
        const batch = needActivity.slice(0, MAX_PER_RUN);
        const remainingAfter = needActivity.length - batch.length;

        let rateRemaining = null;
        let rateReset = null;        // epoch seconds
        let ok = 0, nullCount = 0, errCount = 0, persistPending = 0;

        const waitForReset = async (why) => {
          const ms = rateReset ? (rateReset * 1000 - Date.now()) : 60000;
          const wait = Math.min(Math.max(ms, 5000) + 2000, HARD_WAIT_CAP);
          const secs = Math.ceil(wait / 1000);
          log(`${why} — waiting ${secs}s for X's rate window to reset`);
          progress({ phase: 'activity', found: accounts.length, resolved: ok + nullCount, total: batch.length, paused: true, message: `Rate limit reached — pausing ${secs}s for reset…` });
          // Interruptible wait so Stop works during a long pause.
          const until = Date.now() + wait;
          while (Date.now() < until && !cancelRequested) await sleep(1000);
          rateRemaining = null; // window has reset; let the next call re-measure
        };

        for (let i = 0; i < batch.length; i++) {
          if (cancelRequested) { log('cancelled during activity resolution'); break; }
          const a = batch[i];

          // Proactive pacing: if the window is nearly spent, pause until reset.
          if (rateRemaining != null && rateRemaining <= 2) await waitForReset('budget nearly spent');

          progress({
            phase: 'activity', found: accounts.length,
            resolved: ok + nullCount, total: batch.length,
            message: `Checking activity ${i + 1}/${batch.length}${remainingAfter ? ` (+${remainingAfter} next run)` : ''}…`,
          });

          let res = await sendCmd('replayUserTweets', { userId: a.restId, count: 20 });
          if (res && res.remaining != null) rateRemaining = res.remaining;
          if (res && res.reset != null) rateReset = res.reset;

          // True rate-limit handling: wait until the real reset, then retry once.
          let tries = 0;
          while (res && res.status === 429 && tries < 4) {
            await waitForReset('rate-limited (429)');
            res = await sendCmd('replayUserTweets', { userId: a.restId, count: 20 });
            if (res && res.remaining != null) rateRemaining = res.remaining;
            if (res && res.reset != null) rateReset = res.reset;
            tries++;
          }

          if (res && res.status === 200 && res.body) {
            try {
              const at = parseLatestActivity(JSON.parse(res.body));
              a.lastActivityAt = at;
              cache[a.restId] = at;       // cache success even if null
              persistPending++;
              if (at) ok++; else nullCount++;
              if (i < 3) log(`replay @${a.handle}: http=200 parsedActivity=${at || 'null'}`);
            } catch (e) {
              errCount++;
              if (i < 3) log(`replay @${a.handle}: parse error ${e.message}`);
            }
          } else {
            errCount++;
            if (i < 3) log(`replay @${a.handle}: status=${res && res.status} error=${res && res.error}`);
          }

          // Persist the cache periodically so an interruption loses almost nothing.
          if (persistPending >= 5) {
            await chrome.storage.local.set({ ghostlistActivity: cache });
            persistPending = 0;
          }
          await sleep(jitter(BASE_PACE));
        }

        await chrome.storage.local.set({ ghostlistActivity: cache });
        log(`activity resolution: ${ok} dated, ${nullCount} no-posts, ${errCount} errors; ${remainingAfter} left for next run`);
        if (remainingAfter > 0) {
          progress({ phase: 'activity', message: `Resolved ${batch.length}. ${remainingAfter} remain — run again to continue.` });
        }
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
      log(`${cancelRequested ? 'stopped' : 'done'} — inactive=${result.counts.inactive} active=${result.counts.active} unknown=${result.counts.unknown} total=${result.counts.total}`);
      if (cancelRequested) {
        progress({ phase: 'done', ...result.counts, message: `Stopped. Partial results saved (${result.counts.inactive} ghosts so far).` });
      } else {
        progress({ phase: 'done', ...result.counts });
        chrome.runtime.sendMessage({ type: 'GHOSTLIST_OPEN_RESULTS' }).catch(() => {});
      }
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
    if (msg && msg.type === 'GHOSTLIST_CANCEL') {
      if (scanning) { cancelRequested = true; log('cancel requested'); }
      sendResponse({ ok: true, scanning });
      return true;
    }
    if (msg && msg.type === 'GHOSTLIST_PING') {
      sendResponse({ ok: true, url: location.href, scanning });
      return true;
    }
  });

  injectInterceptor();
})();
