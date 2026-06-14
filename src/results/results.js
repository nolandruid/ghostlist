import { toCsv } from '../lib/csv.js';

const $ = (s) => document.querySelector(s);
const rowsEl = $('#rows');
const emptyEl = $('#empty');

const state = {
  items: [],        // combined inactive + unknown, each tagged with .category
  done: {},         // key -> true (checked-off, persisted)
  sortKey: 'months',
  sortDir: 'desc',
  search: '',
  filter: 'all',
  hideDone: false,
};

const keyOf = (a) => a.restId || a.handle;

function categoryOf(a) {
  if (a.status === 'unknown') return 'unknown';
  if (a.reason === 'never-posted') return 'never';
  return 'dormant';
}

function humanDuration(months) {
  if (months == null) return '—';
  if (months < 1) return '<1 mo';
  if (months < 12) return `${Math.round(months)} mo`;
  const yrs = months / 12;
  return `${yrs.toFixed(yrs < 10 ? 1 : 0)} yr`;
}

function humanDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function profileUrl(handle) { return `https://x.com/${encodeURIComponent(handle)}`; }

// ---- load -----------------------------------------------------------------
chrome.storage.local.get(['ghostlistResult', 'ghostlistDone'], (s) => {
  const result = s.ghostlistResult;
  state.done = s.ghostlistDone || {};
  if (!result) {
    $('#counts').textContent = '';
    emptyEl.style.display = 'block';
    emptyEl.textContent = 'No scan yet. Open the Ghostlist popup on your X Following page and click Scan.';
    return;
  }
  const inactive = (result.inactive || []).map((a) => ({ ...a, category: categoryOf(a) }));
  const unknown = (result.unknown || []).map((a) => ({ ...a, status: 'unknown', category: 'unknown' }));
  state.items = [...inactive, ...unknown];

  const c = result.counts;
  $('#meta').textContent = `Scanned ${new Date(result.scannedAt).toLocaleString()} · threshold ${result.thresholdMonths}+ months`;
  const counts = $('#counts');
  counts.textContent = '';
  counts.append(
    countNode(c.inactive, 'inactive', '#ff8b94'),
    countNode(c.active, 'active', 'var(--ok)'),
    countNode(c.unknown, 'unknown', 'var(--muted)'),
    countNode(c.total, 'total followed', 'var(--text)'),
  );
  render();
});

function countNode(n, label, color) {
  const span = document.createElement('span');
  const b = document.createElement('b');
  b.textContent = String(n);
  b.style.color = color;
  span.append(b, document.createTextNode(' ' + label));
  return span;
}

// ---- render (safe DOM, no innerHTML for user data) ------------------------
function visibleItems() {
  let items = state.items.slice();
  if (state.filter !== 'all') items = items.filter((a) => a.category === state.filter);
  else items = items.filter((a) => a.status !== 'unknown'); // "all inactive" excludes unknown
  if (state.search) {
    const q = state.search.toLowerCase();
    items = items.filter(
      (a) => a.handle.toLowerCase().includes(q) || (a.name || '').toLowerCase().includes(q)
    );
  }
  if (state.hideDone) items = items.filter((a) => !state.done[keyOf(a)]);

  const dir = state.sortDir === 'asc' ? 1 : -1;
  items.sort((a, b) => {
    let av, bv;
    switch (state.sortKey) {
      case 'name': av = (a.name || a.handle).toLowerCase(); bv = (b.name || b.handle).toLowerCase(); break;
      case 'last': av = a.lastActivityAt || ''; bv = b.lastActivityAt || ''; break;
      case 'reason': av = a.category; bv = b.category; break;
      case 'months':
      default:
        // null (never/unknown) sorts as most-inactive
        av = a.monthsSinceActivity == null ? Infinity : a.monthsSinceActivity;
        bv = b.monthsSinceActivity == null ? Infinity : b.monthsSinceActivity;
    }
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
  return items;
}

function render() {
  const items = visibleItems();
  rowsEl.textContent = '';
  emptyEl.style.display = items.length ? 'none' : 'block';
  if (!items.length) emptyEl.textContent = 'Nothing matches these filters.';

  for (const a of items) {
    const tr = document.createElement('tr');
    const k = keyOf(a);
    if (state.done[k]) tr.classList.add('done');

    // checkbox
    const tdCheck = document.createElement('td');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = Boolean(state.done[k]);
    cb.addEventListener('change', () => {
      if (cb.checked) state.done[k] = true; else delete state.done[k];
      chrome.storage.local.set({ ghostlistDone: state.done });
      tr.classList.toggle('done', cb.checked);
      if (state.hideDone && cb.checked) render();
    });
    tdCheck.append(cb);

    // account
    const tdUser = document.createElement('td');
    const wrap = document.createElement('div');
    wrap.className = 'user';
    const img = document.createElement('img');
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    if (a.avatar) img.src = a.avatar;
    const info = document.createElement('div');
    const nameEl = document.createElement('div');
    nameEl.className = 'name';
    nameEl.textContent = a.name || a.handle; // textContent => safe against markup in names
    const link = document.createElement('a');
    link.className = 'handle';
    link.href = profileUrl(a.handle);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = '@' + a.handle;
    info.append(nameEl, link);
    wrap.append(img, info);
    tdUser.append(wrap);

    // inactive for
    const tdMonths = document.createElement('td');
    tdMonths.textContent = a.status === 'unknown' ? '—' : humanDuration(a.monthsSinceActivity);

    // last post
    const tdLast = document.createElement('td');
    tdLast.textContent = humanDate(a.lastActivityAt) || (a.category === 'never' ? 'never posted' : '—');

    // why
    const tdWhy = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = 'pill ' + (a.category === 'never' ? 'never' : a.category === 'dormant' ? 'dormant' : '');
    pill.textContent =
      a.category === 'never' ? 'never posted' :
      a.category === 'unknown' ? (a.reason === 'protected' ? 'protected' : 'no data') :
      'dormant';
    tdWhy.append(pill);

    tr.append(tdCheck, tdUser, tdMonths, tdLast, tdWhy);
    rowsEl.append(tr);
  }

  // reflect select-all state
  const allChecked = items.length > 0 && items.every((a) => state.done[keyOf(a)]);
  $('#selAll').checked = allChecked;
}

// ---- controls -------------------------------------------------------------
$('#search').addEventListener('input', (e) => { state.search = e.target.value.trim(); render(); });
$('#filter').addEventListener('change', (e) => { state.filter = e.target.value; render(); });
$('#hideDone').addEventListener('change', (e) => { state.hideDone = e.target.checked; render(); });

document.querySelectorAll('th[data-sort]').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.sortKey = key;
      state.sortDir = key === 'name' ? 'asc' : 'desc';
    }
    document.querySelectorAll('th[data-sort]').forEach((o) => o.removeAttribute('data-dir'));
    th.setAttribute('data-dir', state.sortDir);
    render();
  });
});

$('#selAll').addEventListener('change', (e) => {
  const items = visibleItems();
  for (const a of items) {
    if (e.target.checked) state.done[keyOf(a)] = true; else delete state.done[keyOf(a)];
  }
  chrome.storage.local.set({ ghostlistDone: state.done });
  render();
});

$('#export').addEventListener('click', () => {
  const items = visibleItems();
  const csv = toCsv(items);
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ghostlist-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

$('#openSel').addEventListener('click', () => {
  const checked = visibleItems().filter((a) => state.done[keyOf(a)]);
  if (!checked.length) { alert('Check the accounts you want to open first.'); return; }
  if (checked.length > 12 && !confirm(`Open ${checked.length} profile tabs?`)) return;
  for (const a of checked) chrome.tabs.create({ url: profileUrl(a.handle), active: false });
});
