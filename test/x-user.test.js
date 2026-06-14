import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractUser, toIso } from '../src/lib/x-user.js';

test('toIso parses Twitter date format', () => {
  assert.equal(toIso('Wed Oct 10 20:19:24 +0000 2018'), '2018-10-10T20:19:24.000Z');
  assert.equal(toIso(null), null);
  assert.equal(toIso('garbage'), null);
});

test('extractUser reads legacy shape including inline status', () => {
  const u = extractUser({
    __typename: 'User',
    rest_id: '222',
    legacy: {
      screen_name: 'gary',
      name: 'Ghost Gary',
      profile_image_url_https: 'https://x/g.jpg',
      statuses_count: 12,
      protected: false,
      status: { created_at: 'Tue Jan 10 09:30:00 +0000 2023' },
    },
  });
  assert.equal(u.restId, '222');
  assert.equal(u.handle, 'gary');
  assert.equal(u.name, 'Ghost Gary');
  assert.equal(u.avatar, 'https://x/g.jpg');
  assert.equal(u.statusesCount, 12);
  assert.equal(u.protectedAccount, false);
  assert.equal(u.lastActivityAt, '2023-01-10T09:30:00.000Z');
});

test('extractUser reads new core/avatar/privacy shape', () => {
  const u = extractUser({
    __typename: 'User',
    rest_id: '555',
    is_blue_verified: true,
    core: { screen_name: 'nora', name: 'Nora' },
    avatar: { image_url: 'https://x/n.jpg' },
    privacy: { protected: true },
    legacy: { statuses_count: 240 },
  });
  assert.equal(u.restId, '555');
  assert.equal(u.handle, 'nora');
  assert.equal(u.name, 'Nora');
  assert.equal(u.avatar, 'https://x/n.jpg');
  assert.equal(u.protectedAccount, true);
  assert.equal(u.verified, true);
  assert.equal(u.lastActivityAt, null);
});

test('extractUser returns null when handle or id missing', () => {
  assert.equal(extractUser(null), null);
  assert.equal(extractUser({ rest_id: '1', legacy: {} }), null);
  assert.equal(extractUser({ legacy: { screen_name: 'x' } }), null);
});

test('extractUser handles UserUnavailable gracefully', () => {
  assert.equal(extractUser({ __typename: 'UserUnavailable' }), null);
});
