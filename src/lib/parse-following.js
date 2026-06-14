// Parse an X `Following` GraphQL response into a list of normalized users.
// We walk the timeline instructions defensively so a shape change in one branch
// doesn't blow up the whole scan. Unit-tested in test/parse-following.test.js.

import { extractUser } from './x-user.js';

function timelineFrom(json) {
  // Known locations across X client versions.
  return (
    json?.data?.user?.result?.timeline?.timeline ??
    json?.data?.user?.result?.timeline ??
    json?.data?.user?.result?.timeline_v2?.timeline ??
    null
  );
}

/**
 * @param {any} json  parsed JSON body of a Following response
 * @returns {{ users: import('./activity.js').Account[], bottomCursor: string|null }}
 */
export function parseFollowing(json) {
  const timeline = timelineFrom(json);
  const users = [];
  let bottomCursor = null;
  if (!timeline?.instructions) return { users, bottomCursor };

  for (const instruction of timeline.instructions) {
    const entries = instruction.entries ?? (instruction.entry ? [instruction.entry] : []);
    for (const entry of entries) {
      const id = entry.entryId ?? '';
      if (id.startsWith('user-')) {
        const result = entry.content?.itemContent?.user_results?.result;
        const user = extractUser(result);
        if (user) users.push(user);
      } else if (id.startsWith('cursor-bottom')) {
        bottomCursor = entry.content?.value ?? null;
      }
    }
  }
  return { users, bottomCursor };
}
