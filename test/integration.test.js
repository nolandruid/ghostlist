// Simulates the full pipeline that content.js performs, end to end, against
// fixtures — the one part the content script's own runtime (Chrome) can't be
// unit-tested. If this passes, the orchestration logic is sound; only the live
// DOM/network glue remains to verify in-browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFollowing } from '../src/lib/parse-following.js';
import { parseLatestActivity } from '../src/lib/parse-tweets.js';
import { classifyAll } from '../src/lib/activity.js';

const load = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
const NOW = Date.parse('2025-06-14T00:00:00Z');

test('following + activity resolution + classification produces correct buckets', () => {
  // 1. Collect following (as content.js merges intercepted Following responses).
  const { users } = parseFollowing(load('following-legacy.json'));
  const byId = new Map(users.map((u) => [u.restId, { ...u }]));

  // 2. Resolve activity for accounts lacking inline status, not protected, with posts.
  //    Here we pretend the replay for the one such account (none in this fixture
  //    lack status except never_ned[0 posts] & private_pat[protected]) — so add a
  //    synthetic "mystery" account that must be resolved from the tweets fixture.
  byId.set('999', { restId: '999', handle: 'mystery_mike', lastActivityAt: null, protectedAccount: false, statusesCount: 800 });

  for (const a of byId.values()) {
    const needs = !a.lastActivityAt && !a.protectedAccount && a.statusesCount !== 0;
    if (needs) {
      a.lastActivityAt = parseLatestActivity(load('user-tweets.json')); // -> 2025-05-21 (active)
    }
  }

  // 3. Classify at 6-month threshold.
  const { inactive, active, unknown } = classifyAll([...byId.values()], { thresholdMonths: 6, now: NOW });

  const inactiveHandles = inactive.map((a) => a.handle);
  assert.ok(inactiveHandles.includes('never_ned'), 'never-posted is inactive');
  assert.ok(inactiveHandles.includes('ghost_gary'), 'dormant since 2023 is inactive');

  const activeHandles = active.map((a) => a.handle);
  assert.ok(activeHandles.includes('active_amy'), 'recent inline status is active');
  assert.ok(activeHandles.includes('mystery_mike'), 'resolved-via-replay recent tweet is active');

  const unknownHandles = unknown.map((a) => a.handle);
  assert.deepEqual(unknownHandles, ['private_pat'], 'protected stays unknown');

  // never_ned (null months) sorts above ghost_gary in the inactive list.
  assert.ok(inactiveHandles.indexOf('never_ned') < inactiveHandles.indexOf('ghost_gary'));
});
