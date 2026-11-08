// Shared console state: the selected workspace, its recent event log and a few
// change counters views watch to refresh. A plain reactive object, no store library.
// Selection, history and streaming live in workspace-session.js.
import { reactive } from 'vue';
import { api, mode } from './api/index.js';
import { createWorkspaceController } from './workspace-session.js';

const WS_KEY = 'agentree.console.workspace';

export const state = reactive({
  mode,
  baseUrl: api.baseUrl,
  workspaces: [],
  workspaceId: null,
  /** idle | connecting | live | reconnecting | closed */
  connection: 'idle',
  /** Recent events of the selected workspace, oldest first. */
  events: [],
  lastSeq: 0,
  /** Activity window: everything with sequence > cursor is loaded. */
  history: { loading: false, loadingOlder: false, error: null, hasOlder: false, cursor: 0 },
  /** Bumped when an event of that kind arrives, so views can reload. */
  changed: { sessions: 0, context: 0, supervision: 0, approvals: 0, tasks: 0 },
  loading: true,
  fatal: null,
});

export const workspace = () => state.workspaces.find((w) => w.id === state.workspaceId) ?? null;

/** Run a gateway call and preserve one error shape for views. */
export async function guard(fn) {
  return fn();
}

const storage = {
  get: () => localStorage.getItem(WS_KEY),
  set: (id) => localStorage.setItem(WS_KEY, id),
};

export const { selectWorkspace, loadOlder, refreshWorkspaces, boot } = createWorkspaceController({ api, state, storage });
