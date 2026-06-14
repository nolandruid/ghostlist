import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseLatestActivity } from '../src/lib/parse-tweets.js';

const tweets = JSON.parse(readFileSync(new URL('./fixtures/user-tweets.json', import.meta.url)));

test('returns the newest non-pinned tweet timestamp', () => {
  // Newest add-entry tweet is 2025-05-21; pinned (2021) must be ignored even
  // though it is chronologically irrelevant — and the older 2025-02 tweet loses.
  assert.equal(parseLatestActivity(tweets), '2025-05-21T18:45:00.000Z');
});

test('ignores pinned tweets entirely', () => {
  // Strip the add-entries so only the pinned remains -> no activity reported.
  const onlyPinned = {
    data: { user: { result: { timeline_v2: { timeline: {
      instructions: tweets.data.user.result.timeline_v2.timeline.instructions.filter(
        (i) => i.type === 'TimelinePinEntry'
      ),
    } } } } },
  };
  assert.equal(parseLatestActivity(onlyPinned), null);
});

test('unwraps TweetWithVisibilityResults', () => {
  // The NEWEST entry is wrapped; if unwrapping failed we would get null/older.
  assert.equal(parseLatestActivity(tweets), '2025-05-21T18:45:00.000Z');
});

test('returns null on garbage without throwing', () => {
  assert.equal(parseLatestActivity({}), null);
  assert.equal(parseLatestActivity(null), null);
});
