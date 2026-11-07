// Live client for the local Gateway (docs/GATEWAY_API.md). REST with the
// HttpOnly console cookie (credentials: 'include') and SSE for live events.
// The admin token is only sent once, to pair the browser; it is never stored.
import { ApiError } from './errors.js';

const BASE = (import.meta.env.VITE_GATEWAY_URL || 'http://localhost:8787').replace(/\/$/, '');

async function request(path, { method = 'GET', body, token } = {}) {
  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      credentials: 'include',
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', `Cannot reach the gateway at ${BASE}`);
  }
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) {
    const error = data?.error ?? {};
    throw new ApiError(response.status, error.code ?? `HTTP_${response.status}`, error.message ?? response.statusText);
  }
  return data;
}

export const live = {
  mode: 'live',
  baseUrl: BASE,

  health: () => request('/health'),
  login: (token) => request('/v1/console/login', { method: 'POST', token }),
  logout: () => request('/v1/console/logout', { method: 'POST' }),

  workspaces: () => request('/v1/workspaces'),
  branches: (workspaceId) => request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/branches`),
  sessions: () => request('/v1/sessions'),
  killSession: (id) => request(`/v1/sessions/${encodeURIComponent(id)}/kill`, { method: 'POST' }),

  events: (workspaceId, { after = 0, limit = 1000 } = {}) =>
    request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/events?after=${after}&limit=${limit}`),

  context: (branchId) => request(`/v1/branches/${encodeURIComponent(branchId)}/context`),
  merges: () => request('/v1/merges'),
  reviews: () => request('/v1/reviews'),
  review: (id) => request(`/v1/reviews/${encodeURIComponent(id)}`),
  resolveReview: (id, decision, resolutions) =>
    request(`/v1/reviews/${encodeURIComponent(id)}`, { method: 'POST', body: { decision, ...(resolutions ? { resolutions } : {}) } }),
  applyMerge: (id) => request(`/v1/merges/${encodeURIComponent(id)}/apply`, { method: 'POST' }),

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
    const source = new EventSource(url, { withCredentials: true });
    onStatus('connecting');
    source.onopen = () => onStatus('live');
    source.onmessage = (message) => {
      try { onEvent(JSON.parse(message.data)); } catch { /* ignore malformed frames */ }
    };
    // CLOSED means the gateway refused the stream (e.g. not paired); otherwise it is retrying.
    source.onerror = () => onStatus(source.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting');
    return () => source.close();
  },
};
