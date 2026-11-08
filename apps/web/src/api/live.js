// Live client for the local Gateway (docs/GATEWAY_API.md). Built Console assets
// use same-origin requests; Vite development can point directly at the Gateway.
import { ApiError } from './errors.js';

// import.meta.env is Vite-only; the optional chain keeps this module loadable in node tests.
const ENV = import.meta.env ?? {};
const BASE = (ENV.VITE_GATEWAY_URL || (ENV.DEV ? 'http://localhost:8787' : '')).replace(/\/$/, '');

// The launcher supplies a one-use capability in a fragment, which is never sent
// in an HTTP URL. Remove it before any later navigation or request.
const consoleReady = (async () => {
  if (typeof window === 'undefined') return;
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const ticket = fragment.get('agentree-ticket');
  if (!ticket) return;
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  const response = await fetch(`${BASE}/v1/console-session`, {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket }),
  });
  if (!response.ok) throw new ApiError(response.status, 'UNAUTHORIZED', 'Console access expired. Open Agentree again from the local CLI.');
})();
// request()/stream() surface errors; avoid an unhandled rejection during startup.
consoleReady.catch(() => {});

async function request(path, { method = 'GET', body } = {}) {
  let response;
  try {
    await consoleReady;
    response = await fetch(`${BASE}${path}`, {
      method,
      credentials: 'include',
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(0, 'NETWORK', `Cannot reach the gateway at ${BASE}`);
  }
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) {
    const error = data?.error ?? {};
    throw new ApiError(response.status, error.code ?? `HTTP_${response.status}`, response.status === 401 ? 'Open Agentree from the local CLI to authorize this Console.' : error.message ?? response.statusText, error.details);
  }
  return data;
}

const unsupported = (what) => new ApiError(501, 'UNSUPPORTED', `${what} is not available on this gateway (needs the Main history API, backend PR #20)`);
// Without PR #20 the old routes reject a restore body (400 BODY / 404): nothing is written.
const rollbackError = (error) => {
  const oldRoute = error instanceof ApiError && ((error.status === 404 && error.message === 'Route not found') || (error.status === 400 && error.code === 'BODY'));
  if (oldRoute) throw unsupported('Main restore');
  throw error;
};

export const live = {
  mode: 'live',
  baseUrl: BASE,

  health: () => request('/health'),
  workspaces: () => request('/v1/workspaces'),
  branches: (workspaceId) => request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/branches`),
  main: (workspaceId) => request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/main`),
  supervision: (workspaceId) => request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/supervision`),
  conflicts: (workspaceId) => request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/conflicts?evidence=1`),
  updateMain: (workspaceId, body) => request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/main`, { method: 'POST', body }),
  updateMainEntry: (workspaceId, entryId, body) => request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/main/${encodeURIComponent(entryId)}`, { method: 'POST', body }),
  mainHistory: (workspaceId, entryId) => request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/main/${encodeURIComponent(entryId)}/history`),
  // Main history and rollback (docs/MAIN_API.md, backend PR #20). A gateway without
  // that PR answers these GETs with the *current* snapshot (the old route reads
  // "history"/"preview" as an entry id), so the responses are shape-checked:
  // showing the current Main as a historical preview would be worse than an error.
  mainRevisions: async (workspaceId) => {
    const result = await request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/main/history`);
    if (!Array.isArray(result)) throw unsupported('Main revision history');
    return result;
  },
  mainPreview: async (workspaceId, revision) => {
    const result = await request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/main/preview?revision=${encodeURIComponent(revision)}`);
    if (!result || result.revision !== revision) throw unsupported('Main snapshot preview');
    return result;
  },
  removeMainEntry: (workspaceId, entryId, body) => request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/main/${encodeURIComponent(entryId)}/remove`, { method: 'POST', body }).catch(rollbackError),
  restoreMain: (workspaceId, body) => request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/main/restore`, { method: 'POST', body }).catch(rollbackError),
  restoreMainEntry: (workspaceId, entryId, body) => request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/main/${encodeURIComponent(entryId)}/restore`, { method: 'POST', body }).catch(rollbackError),
  decideConflict: (workspaceId, id, body) => request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/conflicts/${encodeURIComponent(id)}`, { method: 'POST', body }),
  reportConflict: (workspaceId, body) => request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/conflicts`, { method: 'POST', body }),
  branchWork: (branchId) => request(`/v1/branches/${encodeURIComponent(branchId)}/work`),
  correctBranch: (branchId, body) => request(`/v1/branches/${encodeURIComponent(branchId)}/corrections`, { method: 'POST', body }),
  mergeWork: (branchId, body) => request(`/v1/branches/${encodeURIComponent(branchId)}/merge`, { method: 'POST', body }),
  merges: (workspaceId) => request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/merges`),
  sessions: () => request('/v1/sessions'),
  // Computer-wide process inventory (docs/NATIVE_DISCOVERY.md): metadata only.
  processes: () => request('/v1/processes'),
  refreshProcesses: () => request('/v1/processes/refresh', { method: 'POST' }),
  killSession: (id) => request(`/v1/sessions/${encodeURIComponent(id)}/kill`, { method: 'POST' }),

  events: (workspaceId, { after = 0, limit = 1000 } = {}) =>
    request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/events?after=${after}&limit=${limit}`),

  // Human task dispatch (docs/TASK_DISPATCH_API.md).
  submitTask: (body) => request('/v1/tasks', { method: 'POST', body }),
  tasks: (sessionId) => request(`/v1/tasks${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`),
  task: (id) => request(`/v1/tasks/${encodeURIComponent(id)}`),
  cancelTask: (id) => request(`/v1/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),

  approvals: () => request('/v1/approvals'),
  decideApproval: (id, decision, reason) =>
    request(`/v1/approvals/${encodeURIComponent(id)}`, { method: 'POST', body: { decision, ...(reason ? { reason } : {}) } }),

  /**
   * Subscribe to the gateway event stream. EventSource reconnects by itself and
   * resends the last received `id` as Last-Event-ID, so no event is replayed or lost.
   * Returns a function that closes the stream.
   */
  stream(workspaceId, after, { onEvent, onStatus }) {
    const url = `${BASE}/v1/stream?after=${after}&workspaceId=${encodeURIComponent(workspaceId)}`;
    let source;
    let closed = false;
    onStatus('connecting');
    consoleReady.then(() => {
      if (closed) return;
      source = new EventSource(url, { withCredentials: true });
      source.onopen = () => onStatus('live');
      source.onmessage = (message) => {
        try { onEvent(JSON.parse(message.data)); } catch { /* ignore malformed frames */ }
      };
      source.onerror = () => onStatus(source.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting');
    }).catch(() => { if (!closed) onStatus('closed'); });
    return () => { closed = true; source?.close(); };
  },
};
