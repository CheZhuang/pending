// Workspace selection, recent history and the live stream, scoped to one selection.
//
// Every selectWorkspace() call starts a new generation. Work started for an older
// generation (history pages, "load older", SSE frames, stream status) is dropped
// when it resolves, so rapid switching can never mix two workspaces' state.
import { loadOlder as readOlder, loadRecent } from './history.js';

export const MAX_EVENTS = 3000;

const emptyHistory = (loading = false) => ({ loading, loadingOlder: false, error: null, hasOlder: false, cursor: 0 });

/** Bump the change counters views watch to reload. */
export function classify(changed, event) {
  const t = event.type ?? '';
  if (t.startsWith('session.')) changed.sessions += 1;
  // Only gateway-written tool.* records are approvals; observed "tool.call" is agent telemetry.
  if (t.startsWith('tool.') && event.mode === 'controlled') changed.approvals += 1;
  const supervision = /^(main|work|merge|conflict|correction)\./.test(t);
  if (supervision) changed.supervision += 1;
  if (supervision || t.startsWith('context.') || t.startsWith('branch.')) changed.context += 1;
  // Task records (Gateway) and native turn notifications (task evidence).
  if (t.startsWith('task.') || (event.mode === 'observed' && t.startsWith('turn/'))) changed.tasks += 1;
  // Any session event can refresh branch activity or reported file evidence.
  if (event.sessionId) changed.supervision += 1;
}

/**
 * @param {{ api: any, state: any, storage?: { get(): string|null, set(id: string): void },
 *           maxEvents?: number, recentTarget?: number, olderTarget?: number }} options
 */
export function createWorkspaceController({ api, state, storage = { get: () => null, set: () => {} }, maxEvents = MAX_EVENTS, recentTarget = 200, olderTarget = 300 }) {
  let selection = 0;
  let bootRun = 0;
  let closeStream = null;
  const current = (generation) => generation === selection;

  function push(event, generation, workspaceId) {
    if (!current(generation)) return; // a stream or page from a previous selection
    if (event.workspaceId && event.workspaceId !== workspaceId) return;
    const sequence = event.sequence ?? event.seq;
    if (!(sequence > state.lastSeq)) return; // already have it (history + stream overlap, reconnect replay)
    state.events.push({ ...event, sequence });
    state.lastSeq = sequence;
    if (state.events.length > maxEvents) {
      const dropped = state.events.splice(0, state.events.length - maxEvents);
      // Dropped events become "older" again and can be reloaded on demand.
      state.history.cursor = dropped.at(-1).sequence;
      state.history.hasOlder = true;
    }
    classify(state.changed, event);
  }

  /** Select a workspace: recent history first, then the live stream from its newest sequence. */
  async function selectWorkspace(id) {
    const generation = ++selection;
    closeStream?.();
    closeStream = null;
    state.workspaceId = id ?? null;
    state.events = [];
    state.lastSeq = 0;
    state.connection = 'idle';
    state.history = emptyHistory(!!id);
    if (!id) return;
    try { storage.set(id); } catch { /* storage unavailable */ }

    let recent;
    try {
      recent = await loadRecent(api, id, { target: recentTarget });
    } catch (error) {
      if (current(generation)) state.history = { ...emptyHistory(), error };
      return;
    }
    if (!current(generation)) return;
    for (const event of recent.events) push(event, generation, id);
    // Stream from the newest sequence the Gateway reported, even if the window was empty.
    state.lastSeq = Math.max(state.lastSeq, recent.through);
    state.history = { ...emptyHistory(), cursor: recent.cursor, hasOlder: recent.hasOlder };
    closeStream = api.stream(id, state.lastSeq, {
      onEvent: (event) => push(event, generation, id),
      onStatus: (status) => { if (current(generation)) state.connection = status; },
    });
  }

  /** Prepend an older page of the selected workspace's history. */
  async function loadOlder() {
    const generation = selection;
    const id = state.workspaceId;
    const history = state.history;
    if (!id || !history.hasOlder || history.loadingOlder) return;
    history.loadingOlder = true;
    history.error = null;
    try {
      const older = await readOlder(api, id, history.cursor, { target: olderTarget });
      if (!current(generation)) return;
      const first = state.events[0]?.sequence ?? Infinity;
      state.events.unshift(...older.events.filter((e) => e.sequence < first && (!e.workspaceId || e.workspaceId === id)));
      history.cursor = older.cursor;
      history.hasOlder = older.hasOlder;
    } catch (error) {
      if (current(generation)) history.error = error;
    } finally {
      if (current(generation)) history.loadingOlder = false;
    }
  }

  /** Reload the workspace list without changing the selection (or select one if none is). */
  async function refreshWorkspaces() {
    const generation = selection;
    const workspaces = await api.workspaces();
    if (!current(generation)) return;
    state.workspaces = workspaces;
    if (!state.workspaceId && workspaces.length) await selectWorkspace(workspaces.at(-1).id);
  }

  async function boot() {
    const run = ++bootRun;
    const selectedBefore = selection;
    state.loading = true;
    state.fatal = null;
    try {
      const workspaces = await api.workspaces();
      if (run !== bootRun) return;
      state.workspaces = workspaces;
      // The person picked a workspace while the list was loading: keep their choice.
      if (selection !== selectedBefore && workspaces.some((w) => w.id === state.workspaceId)) return;
      let saved = null;
      try { saved = storage.get(); } catch { /* storage unavailable */ }
      const pick = workspaces.find((w) => w.id === saved) ?? workspaces.at(-1);
      await selectWorkspace(pick?.id ?? null);
    } catch (error) {
      if (run === bootRun) state.fatal = error;
    } finally {
      if (run === bootRun) state.loading = false;
    }
  }

  return { selectWorkspace, loadOlder, refreshWorkspaces, boot, close: () => { selection += 1; closeStream?.(); closeStream = null; } };
}
