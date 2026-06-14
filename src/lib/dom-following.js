// Fallback: scrape the rendered Following page DOM into a user list, for when
// response interception misses (or X changes their GraphQL). This relies on X's
// `data-testid` attributes, which are the most stable hooks they expose but can
// still change — hence the multiple fallbacks and the fixture test. Pure: takes
// a DOM root, returns plain objects. Unit-tested in test/dom-following.test.js.

// Reserved first-segment paths that are NOT user handles.
const NON_HANDLE = new Set([
  'home', 'explore', 'notifications', 'messages', 'i', 'settings', 'search',
  'compose', 'hashtag', 'bookmarks', 'lists', 'topics', 'tos', 'privacy',
]);

const HANDLE_RE = /^\/([A-Za-z0-9_]{1,15})$/;

function handleFromHref(href) {
  if (!href) return null;
  // strip origin if present
  const path = href.replace(/^https?:\/\/[^/]+/, '');
  const m = HANDLE_RE.exec(path);
  if (!m) return null;
  const handle = m[1];
  if (NON_HANDLE.has(handle.toLowerCase())) return null;
  return handle;
}

function parseCell(cell) {
  // Handle: prefer the @-prefixed span, else first handle-shaped link.
  let handle = null;
  const spans = cell.querySelectorAll('span');
  for (const s of spans) {
    const t = (s.textContent || '').trim();
    if (t.startsWith('@') && HANDLE_RE.test('/' + t.slice(1))) {
      handle = t.slice(1);
      break;
    }
  }
  if (!handle) {
    for (const a of cell.querySelectorAll('a[href]')) {
      const h = handleFromHref(a.getAttribute('href'));
      if (h) { handle = h; break; }
    }
  }
  if (!handle) return null;

  // Display name: avatar img alt is the most reliable, else first non-@ span.
  const img = cell.querySelector('img[src]');
  let name;
  if (img && img.getAttribute('alt')) name = img.getAttribute('alt').trim() || undefined;
  if (!name) {
    for (const s of spans) {
      const t = (s.textContent || '').trim();
      if (t && !t.startsWith('@') && t.toLowerCase() !== handle.toLowerCase()) { name = t; break; }
    }
  }

  const avatar = img ? img.getAttribute('src') || undefined : undefined;

  // Protected: a lock glyph near the name. Best-effort — labels vary by locale.
  const protectedAccount = Boolean(
    cell.querySelector('[data-testid="icon-lock"]') ||
    cell.querySelector('svg[aria-label*="rotected" i]')
  );

  return {
    restId: '', // not available from the DOM; matched/filled by rest_id later if possible
    handle,
    name,
    avatar,
    protectedAccount,
    statusesCount: undefined,
    lastActivityAt: null,
  };
}

/**
 * @param {ParentNode} root  document or a subtree containing UserCells
 * @returns {import('./activity.js').Account[]}  deduped by handle, order preserved
 */
export function parseFollowingDom(root) {
  const cells = root.querySelectorAll('[data-testid="UserCell"]');
  const out = [];
  const seen = new Set();
  for (const cell of cells) {
    const user = parseCell(cell);
    if (!user) continue;
    const key = user.handle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(user);
  }
  return out;
}
