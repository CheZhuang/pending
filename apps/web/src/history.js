// Recent-window event history over the Gateway's forward-only events API.
//
// GET /v1/workspaces/:id/events accepts only `after` and `limit` (1–1000) and pages
// upward. Sequences are global across workspaces, so a window is a sequence range
// (after, upTo] read forward, stepping further back when a range is sparse.
// Everything with sequence > `cursor` is loaded; `cursor` 0 means the full history.

export const PAGE_LIMIT = 1000;
/** Sequence span read per step; ≤ PAGE_LIMIT so one page usually covers it. */
export const STRIDE = 500;
const MAX_STRIDE = PAGE_LIMIT * 4;

const seqOf = (e) => e.sequence ?? e.seq;

/** Every event with after < sequence ≤ upTo, paging forward as needed. */
async function readRange(api, workspaceId, after, upTo) {
  const events = [];
  let cursor = after;
  let through = 0;
  for (;;) {
    const page = await api.events(workspaceId, { after: cursor, limit: PAGE_LIMIT });
    through = Math.max(through, page.throughSequence ?? 0);
    for (const event of page.events) {
      const sequence = seqOf(event);
      if (sequence > upTo) return { events, through };
      events.push({ ...event, sequence });
    }
    if (!page.hasMore || page.nextSequence <= cursor) return { events, through };
    cursor = page.nextSequence;
  }
}

/**
 * Step back from `cursor` until at least `target` older events are read, history
 * starts, or `maxSteps` ranges were read (a sparse workspace in a busy Gateway).
 */
export async function loadOlder(api, workspaceId, cursor, { target = 300, stride = STRIDE, maxSteps = 8 } = {}) {
  let after = cursor;
  let step = stride;
  let events = [];
  for (let i = 0; i < maxSteps && after > 0 && events.length < target; i += 1) {
    const from = Math.max(0, after - step);
    const range = await readRange(api, workspaceId, from, after);
    events = range.events.concat(events);
    after = from;
    step = Math.min(step * 2, MAX_STRIDE);
  }
  return { events, cursor: after, hasOlder: after > 0 };
}

/**
 * The newest events of a workspace (about `target`), not its whole history.
 * `through` is the newest sequence the Gateway reported, the point to stream from.
 */
export async function loadRecent(api, workspaceId, { target = 200, stride = STRIDE, maxSteps = 8 } = {}) {
  // A one-event page reports the workspace's newest sequence (throughSequence).
  const head = await api.events(workspaceId, { after: 0, limit: 1 });
  const newest = head.throughSequence ?? 0;
  if (!head.events.length) return { events: [], cursor: 0, through: newest, hasOlder: false };
  const after = Math.max(0, newest - stride);
  const latest = await readRange(api, workspaceId, after, Infinity);
  const older = latest.events.length < target && after > 0
    ? await loadOlder(api, workspaceId, after, { target: target - latest.events.length, stride: stride * 2, maxSteps })
    : { events: [], cursor: after, hasOlder: after > 0 };
  const events = older.events.concat(latest.events);
  const through = Math.max(newest, latest.through, events.length ? seqOf(events.at(-1)) : 0);
  return { events, cursor: older.cursor, through, hasOlder: older.hasOlder };
}
