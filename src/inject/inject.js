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
  // Freshest session auth headers seen on ANY graphql request this page-load.
  // Reused when replaying so we don't send a stale per-request transaction id.
  let freshAuthHeaders = null;
  const AUTH_HEADER_KEYS = [
    'authorization', 'x-csrf-token', 'x-client-transaction-id',
    'x-twitter-active-user', 'x-twitter-auth-type', 'x-twitter-client-language',
  ];
  function captureAuth(headers) {
    const picked = {};
    let any = false;
    for (const [k, v] of Object.entries(headers || {})) {
      if (AUTH_HEADER_KEYS.includes(k.toLowerCase())) { picked[k] = v; any = true; }
    }
    if (any) freshAuthHeaders = picked;
  }

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
    const method = (init && init.method ? String(init.method) : 'GET').toUpperCase();
    const headers = headersToObject(init && init.headers);
    captureAuth(headers); // refresh session auth from every graphql request
    // Only GET operations are meaningful to replay (UserTweets is GET).
    if (method !== 'GET') return;
    const firstTime = !templates[op];
    templates[op] = { url, headers, method };
    // Tell the content script so it can persist the template across reloads.
    post('template', { op, url, headers, method });
    if (firstTime) {
      const hk = Object.keys(headers);
      console.log('%c[ghostlist:inject]', 'color:#1d9bf0;font-weight:bold',
        `captured ${op} request template (headers: ${hk.length ? hk.join(',') : 'NONE'})`);
    }
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
  // X's web client makes its GraphQL calls over XHR, so this is where templates
  // actually get captured (headers are set via setRequestHeader, which we record).
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__gl_url = url;
    this.__gl_method = method;
    this.__gl_headers = {};
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (this.__gl_headers) this.__gl_headers[k] = v;
    return origSetHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const url = this.__gl_url || '';
    const op = url.includes('/graphql/') ? opNameFromUrl(url) : null;
    if (op) {
      rememberTemplate(op, url, { method: this.__gl_method, headers: this.__gl_headers });
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
      post('capabilities', { reqId: d.reqId, ops: Object.keys(templates), hasAuth: Boolean(freshAuthHeaders) });
      return;
    }

    // Restore a template the content script persisted from an earlier session.
    if (d.kind === 'loadTemplate' && d.op && d.template) {
      if (!templates[d.op]) {
        templates[d.op] = d.template;
        console.log('%c[ghostlist:inject]', 'color:#1d9bf0;font-weight:bold', `restored saved ${d.op} template from storage`);
      }
      post('templateLoaded', { reqId: d.reqId, op: d.op, ops: Object.keys(templates) });
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
        // Prefer freshest live auth headers (csrf + transaction id) over the
        // template's possibly-stale ones; fall back to the template headers.
        const headers = { ...tpl.headers, ...(freshAuthHeaders || {}) };
        const res = await origFetch(u.toString(), {
          method: 'GET',
          headers,
          credentials: 'include',
        });
        const body = await res.text();
        // X returns rate-limit budget on these headers (same-origin => readable).
        const remaining = Number(res.headers.get('x-rate-limit-remaining'));
        const reset = Number(res.headers.get('x-rate-limit-reset')); // epoch seconds
        if (res.status !== 200) {
          console.log('%c[ghostlist:inject]', 'color:#f4212e;font-weight:bold',
            `replay UserTweets http=${res.status} for userId=${d.userId}; head=${body.slice(0, 160)}`);
        }
        post('replayResult', {
          reqId: d.reqId, op: 'UserTweets', userId: d.userId, body, status: res.status,
          remaining: Number.isFinite(remaining) ? remaining : null,
          reset: Number.isFinite(reset) ? reset : null,
        });
      } catch (err) {
        post('replayResult', { reqId: d.reqId, error: String(err && err.message || err) });
      }
    }
  });

  console.log('%c[ghostlist:inject]', 'color:#1d9bf0;font-weight:bold', 'interceptor active — watching X GraphQL traffic');
  post('ready', { ops: [] });
})();
