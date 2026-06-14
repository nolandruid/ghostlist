// Service worker (module). Deliberately thin: the content script owns the scan.
// Background just opens/focuses the results page when a scan finishes, so the
// content script (which can't open extension pages) doesn't have to.

let resultsTabId = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'GHOSTLIST_OPEN_RESULTS') {
    openResults();
    sendResponse({ ok: true });
  }
  return false;
});

async function openResults() {
  const url = chrome.runtime.getURL('results/results.html');
  // Reuse an existing results tab if it's still around.
  if (resultsTabId != null) {
    try {
      const tab = await chrome.tabs.get(resultsTabId);
      if (tab) {
        await chrome.tabs.update(resultsTabId, { active: true, url });
        await chrome.windows.update(tab.windowId, { focused: true });
        return;
      }
    } catch (_) {
      resultsTabId = null;
    }
  }
  const tab = await chrome.tabs.create({ url });
  resultsTabId = tab.id;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === resultsTabId) resultsTabId = null;
});
