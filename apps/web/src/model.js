// Small shared labels for sessions shown across supervision and approval views.
export function sessionLabel(session) {
  if (!session) return 'unknown session';
  return session.label || `${session.runtime} · ${session.nativeId}`;
}

export const findSession = (sessions, id) => sessions?.find((s) => s.id === id);
