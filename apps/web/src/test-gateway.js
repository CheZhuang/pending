// Test double for the Gateway's event API, with the storage layer's paging rules
// (packages/storage eventPage): sequences are global, `after` exclusive, results
// capped at `through` = the workspace's newest sequence when the page was read.
export function fakeGateway(initial = []) {
  const events = [...initial];
  const calls = [];
  const streams = [];
  const gates = new Map(); // workspaceId -> promise every events() call for it waits on
  return {
    events: async (workspaceId, { after = 0, limit = 100 } = {}) => {
      calls.push({ workspaceId, after, limit });
      if (gates.has(workspaceId)) await gates.get(workspaceId);
      const own = events.filter((e) => e.workspaceId === workspaceId);
      const through = own.length ? own.at(-1).sequence : 0;
      const rows = own.filter((e) => e.sequence > after && e.sequence <= through);
      const page = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      return { events: page.map((e) => ({ ...e })), nextSequence: hasMore ? page.at(-1).sequence : Math.max(after, through), throughSequence: through, hasMore };
    },
    stream(workspaceId, after, handlers) {
      const stream = { workspaceId, after, ...handlers, closed: false };
      streams.push(stream);
      handlers.onStatus('connecting');
      return () => { stream.closed = true; };
    },
    workspaces: async () => [],
    /** Hold every events() call for a workspace until the returned function is called. */
    hold(workspaceId) {
      let release;
      gates.set(workspaceId, new Promise((r) => { release = r; }));
      return () => { gates.delete(workspaceId); release(); };
    },
    append(event) { events.push(event); return event; },
    calls,
    streams,
  };
}

/** `count` events for one workspace, optionally interleaved with another workspace's. */
export function history({ workspaceId = 'w', count, every = 1, start = 1 }) {
  const out = [];
  for (let i = 0, seq = start; i < count; seq += 1) {
    const mine = (seq - start) % every === 0;
    out.push({ id: `e${seq}`, sequence: seq, workspaceId: mine ? workspaceId : 'other', type: 'tool.call', mode: 'observed', source: 'test', payload: {} });
    if (mine) i += 1;
  }
  return out;
}
