// Defensive extraction of a normalized user record from an X "User result"
// object. X has been migrating user fields out of `legacy` into `core`/top-level
// over time, so we read from every known location and take the first hit.
// Unit-tested in test/x-user.test.js against both old and new shapes.

function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
}

/**
 * @param {any} result  a `user_results.result` (or `result.result`) node
 * @returns {import('./activity.js').Account | null}
 */
export function extractUser(result) {
  if (!result) return null;
  // Some responses wrap the real user under result.result (e.g. UserWithProfile).
  const r = result.__typename === 'UserUnavailable' ? null : result.result ?? result;
  if (!r) return null;

  const legacy = r.legacy ?? {};
  const core = r.core ?? {};

  const restId = firstDefined(r.rest_id, r.restId, legacy.id_str);
  const handle = firstDefined(core.screen_name, legacy.screen_name);
  if (!restId || !handle) return null;

  const name = firstDefined(core.name, legacy.name);
  const avatar = firstDefined(
    r.avatar?.image_url,
    legacy.profile_image_url_https,
    core.profile_image_url_https
  );
  const statusesCount = firstDefined(legacy.statuses_count, r.statuses_count);
  const protectedAccount = firstDefined(r.privacy?.protected, legacy.protected, r.protected, false);
  const verified = firstDefined(
    r.is_blue_verified,
    r.verification?.verified,
    legacy.verified,
    false
  );

  // Some list responses inline the user's most-recent post as `legacy.status`
  // (the classic REST `user.status`). When present it saves us a profile visit.
  const inlineStatusAt = legacy.status?.created_at ?? null;

  return {
    restId: String(restId),
    handle: String(handle),
    name: name != null ? String(name) : undefined,
    avatar: avatar != null ? String(avatar) : undefined,
    statusesCount: typeof statusesCount === 'number' ? statusesCount : undefined,
    protectedAccount: Boolean(protectedAccount),
    verified: Boolean(verified),
    lastActivityAt: inlineStatusAt ? toIso(inlineStatusAt) : null,
  };
}

/** Twitter dates look like "Wed Oct 10 20:19:24 +0000 2018". Date.parse handles them. */
export function toIso(twitterDate) {
  if (!twitterDate) return null;
  const ts = Date.parse(twitterDate);
  if (Number.isNaN(ts)) return null;
  return new Date(ts).toISOString();
}
