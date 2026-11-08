// Shared console state: the selected workspace, the live event log and a few
// change counters views watch to refresh. A plain reactive object, no store library.
import { reactive } from 'vue';
import { allEvents, api, mode } from './api/index.js';
import { ApiError } from './api/errors.js';

const WS_KEY = 'agentree.console.workspace';
const MAX_EVENTS = 3000;

export const state = reactive({
  mode,
  baseUrl: api.baseUrl,
  /** true when the gateway said 401: the browser has to be paired with the admin token. */
  needsLogin: false,
  workspaces: [],
  workspaceId: null,
  /** idle | connecting | live | reconnecting | closed */
  connection: 'idle',
  events: [],
  lastSeq: 0,
  /** Bumped when an event of that kind arrives, so views can reload. */
  changed: { sessions: 0, context: 0, supervision: 0, approvals: 0, tasks: 0 },
  loading: true,
  fatal: null,
});

export const workspace = () => state.workspaces.find((w) => w.id === state.workspaceId) ?? null;

/** Run a gateway call; a 401 opens the pairing dialog instead of failing silently. */
export async function guard(fn) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) state.needsLogin = true;
    throw error;
  }
}

let closeStream = null;

function classify(event) {
  const t = event.type;
  if (t.startsWith('session.')) state.changed.sessions += 1;
  // Only gateway-written tool.* records are approvals; observed "tool.call" is agent telemetry.
  if (t.startsWith('tool.') && event.mode === 'controlled') state.changed.approvals += 1;
  if (t.startsWith('main.') || t.startsWith('work.') || t.startsWith('merge.') || t.startsWith('conflict.') || t.startsWith('correction.')) state.changed.supervision += 1;
  if (t.startsWith('context.') || t.startsWith('main.') || t.startsWith('work.') || t.startsWith('merge.') || t.startsWith('conflict.') || t.startsWith('correction.') || t.startsWith('branch.')) state.changed.context += 1;
  // Task records (Gateway) and native turn notifications (task evidence).
  if (t.startsWith('task.') || (event.mode === 'observed' && t.startsWith('turn/'))) state.changed.tasks += 1;
  // Any session event can refresh branch activity or reported file evidence.
  if (event.sessionId) state.changed.supervision += 1;
}

function push(event) {
  const seq = event.sequence ?? event.seq;
  if (seq <= state.lastSeq) return; // already have it (history + stream overlap)
  state.events.push({ ...event, sequence: seq });
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
  state.lastSeq = seq;
  classify(event);
}

/** Load the history of the selected workspace, then follow the live stream from its last sequence. */
export async function selectWorkspace(id) {
  closeStream?.();
  state.workspaceId = id;
  state.events = [];
  state.lastSeq = 0;
  try { localStorage.setItem(WS_KEY, id); } catch { /* storage unavailable */ }
  if (!id) return;
  const history = await guard(() => allEvents(id));
  for (const event of history) push(event);
  closeStream = api.stream(id, state.lastSeq, {
    onEvent: push,
    onStatus: (status) => { state.connection = status; },
  });
}

export async function boot() {
  state.loading = true;
  state.fatal = null;
  try {
    state.workspaces = await guard(() => api.workspaces());
    state.needsLogin = false;
    let saved = null;
    try { saved = localStorage.getItem(WS_KEY); } catch { /* storage unavailable */ }
    const pick = state.workspaces.find((w) => w.id === saved) ?? state.workspaces.at(-1);
    await selectWorkspace(pick?.id ?? null);
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) state.fatal = error;
  } finally {
    state.loading = false;
  }
}

export async function pair(token) {
  await api.login(token);
  state.needsLogin = false;
  await boot();
}
