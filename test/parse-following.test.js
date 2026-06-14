import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFollowing } from '../src/lib/parse-following.js';

const legacy = JSON.parse(readFileSync(new URL('./fixtures/following-legacy.json', import.meta.url)));
const core = JSON.parse(readFileSync(new URL('./fixtures/following-core.json', import.meta.url)));

test('parses all users from legacy Following response', () => {
  const { users, bottomCursor } = parseFollowing(legacy);
  assert.deepEqual(users.map((u) => u.handle), ['active_amy', 'ghost_gary', 'private_pat', 'never_ned']);
  assert.equal(bottomCursor, 'CURSOR_NEXT_PAGE');
});

test('extracts inline status timestamps when present', () => {
  const { users } = parseFollowing(legacy);
  const amy = users.find((u) => u.handle === 'active_amy');
  assert.equal(amy.lastActivityAt, '2025-06-02T12:00:00.000Z');
  const pat = users.find((u) => u.handle === 'private_pat');
  assert.equal(pat.lastActivityAt, null);
  assert.equal(pat.protectedAccount, true);
});

test('parses new core shape and empty cursor', () => {
  const { users, bottomCursor } = parseFollowing(core);
  assert.equal(users.length, 1);
  assert.equal(users[0].handle, 'new_shape_nora');
  assert.equal(users[0].avatar, 'https://pbs.twimg.com/nora.jpg');
  assert.equal(bottomCursor, '');
});

test('returns empty result on garbage input without throwing', () => {
  assert.deepEqual(parseFollowing({}), { users: [], bottomCursor: null });
  assert.deepEqual(parseFollowing(null), { users: [], bottomCursor: null });
  assert.deepEqual(parseFollowing({ data: { user: {} } }), { users: [], bottomCursor: null });
});
