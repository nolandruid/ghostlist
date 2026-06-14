// Parse an X `UserTweets` GraphQL response and return the timestamp of the
// account's most recent activity (original post OR retweet), ignoring pinned
// tweets. Pinned tweets arrive in a separate `TimelinePinEntry` instruction,
// which we skip — otherwise an account that pinned an old tweet but went dormant
// would look "active". Unit-tested in test/parse-tweets.test.js.

import { toIso } from './x-user.js';

function timelineFrom(json) {
  return (
    json?.data?.user?.result?.timeline_v2?.timeline ??
    json?.data?.user?.result?.timeline?.timeline ??
    json?.data?.user?.result?.timeline ??
    null
  );
}

function createdAtOf(tweetResult) {
  const r = tweetResult?.result ?? tweetResult;
  if (!r) return null;
  // TweetWithVisibilityResults wraps the real tweet under .tweet
  const t = r.__typename === 'TweetWithVisibilityResults' ? r.tweet : r;
  return t?.legacy?.created_at ?? null;
}

/**
 * @param {any} json  parsed JSON body of a UserTweets response
 * @returns {string|null} ISO timestamp of latest non-pinned activity, or null
 */
export function parseLatestActivity(json) {
  const timeline = timelineFrom(json);
  if (!timeline?.instructions) return null;

  let latest = null;
  for (const instruction of timeline.instructions) {
    // Skip pinned entries entirely.
    if (instruction.type === 'TimelinePinEntry') continue;
    const entries = instruction.entries ?? [];
    for (const entry of entries) {
      const id = entry.entryId ?? '';
      // Top-level tweets only (entryId "tweet-<id>"); skip cursors, modules,
      // who-to-follow, conversation threads, promoted content.
      if (!id.startsWith('tweet-')) continue;
      const created = createdAtOf(entry.content?.itemContent?.tweet_results);
      const iso = toIso(created);
      if (iso && (!latest || iso > latest)) latest = iso;
    }
  }
  return latest;
}
