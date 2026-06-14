const $ = (sel) => document.querySelector(sel);
const statusEl = $('#status');
const bar = $('#bar');
const barFill = bar.querySelector('i');
const scanBtn = $('#scan');
const viewBtn = $('#view');

function setStatus(html, cls = '') {
  statusEl.className = `status ${cls}`;
  statusEl.innerHTML = html;
}
function setBar(pct) {
  if (pct == null) { bar.style.display = 'none'; return; }
  bar.style.display = 'block';
  barFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

function selectedMonths() {
  const checked = document.querySelector('input[name="months"]:checked');
  return Number(checked ? checked.value : 6);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isFollowingUrl(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)x\.com$/.test(u.hostname) && !/(^|\.)twitter\.com$/.test(u.hostname)) return false;
    return /\/following\/?$/.test(u.pathname);
  } catch { return false; }
}
function isXUrl(url) {
  try {
    const u = new URL(url);
    return /(^|\.)(x|twitter)\.com$/.test(u.hostname);
  } catch { return false; }
}

// Restore last threshold + show existing results entry point.
chrome.storage.local.get(['ghostlistThreshold', 'ghostlistResult'], (s) => {
  if (s.ghostlistThreshold) {
    const r = document.querySelector(`input[name="months"][value="${s.ghostlistThreshold}"]`);
    if (r) r.checked = true;
  }
  if (s.ghostlistResult) {
    viewBtn.style.display = 'block';
    viewBtn.textContent = `View last results (${s.ghostlistResult.counts.inactive} ghosts)`;
  }
});

(async function init() {
  const tab = await activeTab();
  if (!tab || !isXUrl(tab.url)) {
    setStatus('Open <b>x.com</b> and go to your <b>Following</b> page, then reopen this.', 'warn');
    scanBtn.disabled = true;
  } else if (!isFollowingUrl(tab.url)) {
    setStatus('Go to your own <b>Following</b> page (profile → Following), then click Scan.', 'warn');
  } else {
    setStatus('Ready. This scrolls your Following list — keep the tab open.');
  }
})();

scanBtn.addEventListener('click', async () => {
  const months = selectedMonths();
  chrome.storage.local.set({ ghostlistThreshold: months });
  const tab = await activeTab();
  if (!tab || !isXUrl(tab.url)) {
    setStatus('Please open x.com first.', 'err');
    return;
  }
  // Make sure the content script is alive.
  let pong;
  try { pong = await chrome.tabs.sendMessage(tab.id, { type: 'GHOSTLIST_PING' }); } catch { /* not injected */ }
  if (!pong) {
    setStatus('Reload the X tab once (the extension was just installed), then try again.', 'warn');
    return;
  }
  scanBtn.disabled = true;
  setStatus('Starting…');
  setBar(2);
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'GHOSTLIST_START', thresholdMonths: months });
  } catch (e) {
    setStatus(`Couldn't start: ${e.message}`, 'err');
    scanBtn.disabled = false;
    setBar(null);
  }
});

viewBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('results/results.html') });
});

function renderProgress(msg) {
  if (!msg || !msg.phase) return;
  if (msg.phase === 'collecting') {
    setStatus(msg.message || 'Collecting…');
    setBar(10);
    scanBtn.disabled = true;
  } else if (msg.phase === 'activity') {
    scanBtn.disabled = true;
    if (msg.total) {
      setStatus(msg.message, msg.paused ? 'warn' : '');
      setBar(10 + (70 * (msg.resolved || 0)) / msg.total);
    } else {
      setStatus(msg.message || 'Checking activity…');
    }
  } else if (msg.phase === 'done') {
    setBar(100);
    setStatus(`Done — <b>${msg.inactive}</b> inactive of ${msg.total}. Opening results…`, 'ok');
    scanBtn.disabled = false;
    viewBtn.style.display = 'block';
    viewBtn.textContent = `View results (${msg.inactive} ghosts)`;
  } else if (msg.phase === 'error') {
    setStatus(msg.message || 'Something went wrong.', 'err');
    scanBtn.disabled = false;
    setBar(null);
  }
}

// Live progress from the content script while the popup is open.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'GHOSTLIST_PROGRESS') renderProgress(msg);
});

// Reattach to an in-flight scan: the scan runs in the page (it keeps going when
// the popup closes), and writes progress to storage. On open, and then on a
// poll, reflect that state so reopening the popup never looks "reset".
const ACTIVE_PHASES = new Set(['collecting', 'activity']);
function reattach() {
  chrome.storage.local.get('ghostlistProgress', (s) => {
    const p = s.ghostlistProgress;
    if (!p) return;
    const fresh = Date.now() - (p.at || 0) < 20000; // last update < 20s ago
    if (ACTIVE_PHASES.has(p.phase) && fresh) renderProgress(p);
    else if (p.phase === 'done') renderProgress(p);
  });
}
reattach();
setInterval(reattach, 1500);
