// Runs in the PAGE context (not the content-script sandbox) so it can see the
// site's own fetch/XHR traffic and reuse the page's authenticated request
// context. It does two things:
//
//   1. Tees the JSON bodies of X GraphQL responses we care about (Following,
//      UserTweets) back to the content script via window.postMessage.
//   2. Remembers the most recent *genuine* request template per operation, so
//      the content script can ask us to "replay" e.g. UserTweets for a different
//      userId using X's real headers/queryId — no hand-forged signed requests.
//
// Self-contained on purpose: page context has no access to chrome.* or ES module
// imports from the extension, so there are no imports here. All parsing of the
// forwarded bodies happens in the content script against the unit-tested libs.

(() => {
  const TAG = 'ghostlist';
  const OPS_TO_TEE = new Set(['Following', 'UserTweets']);
  // Latest genuine request template per operation: { url, headers, method }.
  const templates = Object.create(null);

  function opNameFromUrl(url) {
    // X GraphQL: https://x.com/i/api/graphql/<queryId>/<OperationName>?...
    const m = /\/graphql\/[^/]+\/([^/?]+)/.exec(url);
    return m ? m[1] : null;
  }

  function headersToObject(headers) {
    const out = {};
    if (!headers) return out;
    if (headers instanceof Headers) {
      headers.forEach((v, k) => { out[k] = v; });
    } else if (Array.isArray(headers)) {
      for (const [k, v] of headers) out[k] = v;
    } else if (typeof headers === 'object') {
      Object.assign(out, headers);
    }
    return out;
  }

  function rememberTemplate(op, url, init) {
    // Only GET operations are safe/meaningful to replay.
    const method = (init && init.method ? String(init.method) : 'GET').toUpperCase();
    if (method !== 'GET') return;
    templates[op] = { url, headers: headersToObject(init && init.headers), method };
  }

  function post(kind, payload) {
    window.postMessage({ source: TAG, kind, ...payload }, window.location.origin);
  }

  function handleResponseBody(op, url, body) {
    if (!OPS_TO_TEE.has(op)) return;
    post('response', { op, url, body });
  }

  // --- patch fetch -----------------------------------------------------------
  const origFetch = window.fetch;
  window.fetch = function patchedFetch(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const op = url.includes('/graphql/') ? opNameFromUrl(url) : null;
    if (op) {
      // Capture the request template from either the Request object or init.
      if (typeof input !== 'string' && input && input.headers) {
        rememberTemplate(op, url, { method: input.method, headers: input.headers });
      } else {
        rememberTemplate(op, url, init || {});
      }
    }
    const p = origFetch.apply(this, arguments);
    if (op && OPS_TO_TEE.has(op)) {
      p.then((res) => {
        res.clone().text().then((body) => handleResponseBody(op, url, body)).catch(() => {});
      }).catch(() => {});
    }
    return p;
  };

  // --- patch XMLHttpRequest ---------------------------------------------------
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__gl_url = url;
    this.__gl_method = method;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const url = this.__gl_url || '';
    const op = url.includes('/graphql/') ? opNameFromUrl(url) : null;
    if (op) {
      this.addEventListener('load', () => {
        try {
          const textual = this.responseType === '' || this.responseType === 'text';
          if (OPS_TO_TEE.has(op) && textual) {
            handleResponseBody(op, url, this.responseText);
          }
        } catch (_) { /* ignore */ }
      });
    }
    return origSend.apply(this, arguments);
  };

  // --- replay-on-command ------------------------------------------------------
  // Content script -> page: { source:'ghostlist-cmd', kind:'replayUserTweets', userId, reqId, count }
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.source !== `${TAG}-cmd`) return;

    if (d.kind === 'capabilities') {
      post('capabilities', { reqId: d.reqId, ops: Object.keys(templates) });
      return;
    }

    if (d.kind === 'replayUserTweets') {
      const tpl = templates['UserTweets'];
      if (!tpl) { post('replayResult', { reqId: d.reqId, error: 'no-template' }); return; }
      try {
        const u = new URL(tpl.url, window.location.origin);
        const vars = JSON.parse(u.searchParams.get('variables') || '{}');
        vars.userId = String(d.userId);
        if (d.count) vars.count = d.count;
        u.searchParams.set('variables', JSON.stringify(vars));
        const res = await origFetch(u.toString(), {
          method: 'GET',
          headers: tpl.headers,
          credentials: 'include',
        });
        const body = await res.text();
        post('replayResult', { reqId: d.reqId, op: 'UserTweets', userId: d.userId, body, status: res.status });
      } catch (err) {
        post('replayResult', { reqId: d.reqId, error: String(err && err.message || err) });
      }
    }
  });

  post('ready', { ops: [] });
})();
