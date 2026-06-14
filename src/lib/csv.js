// Tiny RFC-4180-ish CSV builder for exporting the ghost list. Pure + tested.

function escapeField(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

const COLUMNS = [
  ['handle', (a) => a.handle],
  ['name', (a) => a.name ?? ''],
  ['profile_url', (a) => `https://x.com/${a.handle}`],
  ['last_activity', (a) => a.lastActivityAt ?? ''],
  ['months_inactive', (a) => (a.monthsSinceActivity == null ? '' : a.monthsSinceActivity.toFixed(1))],
  ['reason', (a) => a.reason ?? ''],
];

/**
 * @param {Array<import('./activity.js').Account & {monthsSinceActivity?: number|null, reason?: string}>} accounts
 * @returns {string} CSV text with header row
 */
export function toCsv(accounts) {
  const header = COLUMNS.map(([h]) => h).join(',');
  const rows = accounts.map((a) => COLUMNS.map(([, fn]) => escapeField(fn(a))).join(','));
  return [header, ...rows].join('\r\n');
}
