import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { parseFollowingDom } from '../src/lib/dom-following.js';

const html = readFileSync(new URL('./fixtures/following-page.html', import.meta.url), 'utf8');
const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);

test('extracts real follow handles, skips reserved /i/ cells', () => {
  const users = parseFollowingDom(document);
  assert.deepEqual(users.map((u) => u.handle), ['active_amy', 'ghost_gary', 'private_pat']);
});

test('captures display name and avatar from the cell', () => {
  const users = parseFollowingDom(document);
  const amy = users.find((u) => u.handle === 'active_amy');
  assert.equal(amy.name, 'Active Amy');
  assert.equal(amy.avatar, 'https://pbs.twimg.com/amy.jpg');
  assert.equal(amy.lastActivityAt, null); // DOM list carries no activity data
});

test('detects protected accounts via lock label', () => {
  const users = parseFollowingDom(document);
  const pat = users.find((u) => u.handle === 'private_pat');
  assert.equal(pat.protectedAccount, true);
});

test('dedupes repeated handles', () => {
  const dup = `${html}${html}`;
  const { document: doc2 } = parseHTML(`<!doctype html><html><body>${dup}</body></html>`);
  const users = parseFollowingDom(doc2);
  assert.equal(users.length, 3);
});
