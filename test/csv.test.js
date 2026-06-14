import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv } from '../src/lib/csv.js';

test('builds header + rows with profile url', () => {
  const csv = toCsv([
    { handle: 'gary', name: 'Ghost Gary', lastActivityAt: '2023-01-10T00:00:00Z', monthsSinceActivity: 29.1, reason: 'no-posts-in-window' },
  ]);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'handle,name,profile_url,last_activity,months_inactive,reason');
  assert.equal(lines[1], 'gary,Ghost Gary,https://x.com/gary,2023-01-10T00:00:00Z,29.1,no-posts-in-window');
});

test('escapes commas, quotes, and newlines', () => {
  const csv = toCsv([{ handle: 'x', name: 'Doe, "Jane"\nJr', monthsSinceActivity: null }]);
  const row = csv.split('\r\n')[1];
  assert.ok(row.includes('"Doe, ""Jane""\nJr"'));
  assert.ok(row.endsWith(',,')); // empty months + empty reason
});
