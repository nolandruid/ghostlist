import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAccount, classifyAll, monthsSince, MS_PER_MONTH } from '../src/lib/activity.js';

const NOW = Date.parse('2025-06-14T00:00:00Z');

test('monthsSince returns null for missing/invalid input', () => {
  assert.equal(monthsSince(null, NOW), null);
  assert.equal(monthsSince('not a date', NOW), null);
});

test('monthsSince computes float months', () => {
  const sixMonthsAgo = NOW - 6 * MS_PER_MONTH;
  assert.ok(Math.abs(monthsSince(new Date(sixMonthsAgo).toISOString(), NOW) - 6) < 1e-6);
});

test('recent poster is active', () => {
  const r = classifyAccount(
    { restId: '1', handle: 'amy', lastActivityAt: '2025-06-02T00:00:00Z', statusesCount: 100 },
    { thresholdMonths: 6, now: NOW }
  );
  assert.equal(r.status, 'active');
});

test('long-dormant poster is inactive at both thresholds', () => {
  const acc = { restId: '2', handle: 'gary', lastActivityAt: '2023-01-10T00:00:00Z', statusesCount: 12 };
  assert.equal(classifyAccount(acc, { thresholdMonths: 6, now: NOW }).status, 'inactive');
  assert.equal(classifyAccount(acc, { thresholdMonths: 12, now: NOW }).status, 'inactive');
});

test('threshold boundary: 12mo-dormant is inactive at 6 but active at 12', () => {
  const acc = { restId: '3', handle: 'borderline', lastActivityAt: new Date(NOW - 9 * MS_PER_MONTH).toISOString(), statusesCount: 3 };
  assert.equal(classifyAccount(acc, { thresholdMonths: 6, now: NOW }).status, 'inactive');
  assert.equal(classifyAccount(acc, { thresholdMonths: 12, now: NOW }).status, 'active');
});

test('protected account with no data is unknown, never inactive', () => {
  const r = classifyAccount(
    { restId: '4', handle: 'pat', lastActivityAt: null, protectedAccount: true, statusesCount: 80 },
    { thresholdMonths: 6, now: NOW }
  );
  assert.equal(r.status, 'unknown');
  assert.equal(r.reason, 'protected');
});

test('public account that never posted is inactive (never-posted)', () => {
  const r = classifyAccount(
    { restId: '5', handle: 'ned', lastActivityAt: null, protectedAccount: false, statusesCount: 0 },
    { thresholdMonths: 6, now: NOW }
  );
  assert.equal(r.status, 'inactive');
  assert.equal(r.reason, 'never-posted');
});

test('public account with posts but no resolved timestamp is unknown (conservative)', () => {
  const r = classifyAccount(
    { restId: '6', handle: 'mystery', lastActivityAt: null, protectedAccount: false, statusesCount: 500 },
    { thresholdMonths: 6, now: NOW }
  );
  assert.equal(r.status, 'unknown');
});

test('future timestamp (clock skew) is clamped to active, not negative', () => {
  const r = classifyAccount(
    { restId: '7', handle: 'future', lastActivityAt: new Date(NOW + 5 * MS_PER_MONTH).toISOString() },
    { thresholdMonths: 6, now: NOW }
  );
  assert.equal(r.status, 'active');
  assert.equal(r.monthsSinceActivity, 0);
});

test('classifyAll buckets and sorts inactive most-dormant-first, never-posted on top', () => {
  const accounts = [
    { restId: '1', handle: 'amy', lastActivityAt: '2025-06-02T00:00:00Z', statusesCount: 100 },
    { restId: '2', handle: 'gary', lastActivityAt: '2023-01-10T00:00:00Z', statusesCount: 12 },
    { restId: '8', handle: 'older', lastActivityAt: '2020-01-01T00:00:00Z', statusesCount: 9 },
    { restId: '5', handle: 'ned', lastActivityAt: null, protectedAccount: false, statusesCount: 0 },
    { restId: '4', handle: 'pat', lastActivityAt: null, protectedAccount: true, statusesCount: 80 },
  ];
  const { inactive, active, unknown } = classifyAll(accounts, { thresholdMonths: 6, now: NOW });
  assert.deepEqual(inactive.map((a) => a.handle), ['ned', 'older', 'gary']);
  assert.deepEqual(active.map((a) => a.handle), ['amy']);
  assert.deepEqual(unknown.map((a) => a.handle), ['pat']);
});
