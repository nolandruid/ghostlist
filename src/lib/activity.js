// Pure inactivity-classification logic. No DOM, no chrome APIs — unit-tested in
// test/activity.test.js. Everything here is deterministic given an explicit `now`.

export const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Average Gregorian month length, so "6 months" means the same regardless of
// which months are spanned. 365.2425 / 12.
export const DAYS_PER_MONTH = 30.436875;
export const MS_PER_MONTH = DAYS_PER_MONTH * MS_PER_DAY;

// Allowed thresholds for v1 (the user picks one of these in the popup).
export const THRESHOLDS = [6, 12];

/**
 * @typedef {Object} Account
 * @property {string} restId        X numeric user id (stable across handle changes)
 * @property {string} handle        screen name without leading @
 * @property {string} [name]        display name
 * @property {string} [avatar]      profile image url
 * @property {string|null} [lastActivityAt]  ISO timestamp of most recent post/retweet, or null if unknown
 * @property {number} [statusesCount]        total posts as reported by X (used to detect never-posters)
 * @property {boolean} [protectedAccount]    true if the account is private (we can't read their tweets)
 * @property {boolean} [verified]
 */

/**
 * Whole months between two instants, as a float. Negative if `lastActivityAt`
 * is in the future (clock skew / pinned weirdness) — callers treat <0 as 0.
 */
export function monthsSince(lastActivityAt, now) {
  if (!lastActivityAt) return null;
  const then = typeof lastActivityAt === 'number' ? lastActivityAt : Date.parse(lastActivityAt);
  if (Number.isNaN(then)) return null;
  return (now - then) / MS_PER_MONTH;
}

/**
 * Classify a single account against a threshold.
 *
 * status:
 *   'active'   — posted within the threshold window
 *   'inactive' — a "ghost": posted longer ago than the threshold, or provably never posted
 *   'unknown'  — we genuinely can't tell (protected account, or fetch failed)
 *
 * We are deliberately conservative: anything ambiguous lands in 'unknown' rather
 * than 'inactive', so the user never gets nudged to unfollow someone on bad data.
 *
 * @param {Account} account
 * @param {{ thresholdMonths: number, now: number }} opts
 */
export function classifyAccount(account, { thresholdMonths, now }) {
  const months = monthsSince(account.lastActivityAt, now);

  let status;
  let reason;

  if (months !== null) {
    const m = Math.max(0, months);
    if (m >= thresholdMonths) {
      status = 'inactive';
      reason = 'no-posts-in-window';
    } else {
      status = 'active';
      reason = 'recent-post';
    }
  } else if (account.protectedAccount) {
    // Private account — we can't see their posts, so we can't judge them.
    status = 'unknown';
    reason = 'protected';
  } else if (account.statusesCount === 0) {
    // Public account that has provably never posted is the platonic ghost.
    status = 'inactive';
    reason = 'never-posted';
  } else {
    // Public, claims to have posts, but we couldn't resolve a timestamp.
    status = 'unknown';
    reason = 'no-activity-data';
  }

  return {
    ...account,
    status,
    reason,
    monthsSinceActivity: months === null ? null : Math.max(0, months),
  };
}

/**
 * Classify a list and split it into buckets. Inactive accounts are sorted
 * most-dormant-first; never-posted accounts (null months) sort to the very top.
 *
 * @param {Account[]} accounts
 * @param {{ thresholdMonths: number, now: number }} opts
 */
export function classifyAll(accounts, opts) {
  const classified = accounts.map((a) => classifyAccount(a, opts));

  const inactive = classified
    .filter((a) => a.status === 'inactive')
    .sort((a, b) => {
      // never-posted (null) first, then longest-dormant first
      if (a.monthsSinceActivity === null && b.monthsSinceActivity === null) return 0;
      if (a.monthsSinceActivity === null) return -1;
      if (b.monthsSinceActivity === null) return 1;
      return b.monthsSinceActivity - a.monthsSinceActivity;
    });

  return {
    inactive,
    active: classified.filter((a) => a.status === 'active'),
    unknown: classified.filter((a) => a.status === 'unknown'),
    all: classified,
  };
}
