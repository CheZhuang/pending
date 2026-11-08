// Gateway errors as the UI sees them: HTTP status + gateway code + message
// (+ optional details, e.g. STALE {expectedRevision, currentRevision}).
// Both the live client and the mock throw this, so views handle one shape.

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}

const HINTS = {
  UNAUTHORIZED: 'The Gateway did not accept this request. Check its origin and access configuration.',
  DENY: 'The gateway refused this for the current credential. The refusal is in the audit log.',
  STATE: 'The record changed state on the server. The list has been refreshed.',
  STALE: 'Main changed since you opened this. Reload, review the latest reference, then retry.',
  NETWORK: 'The gateway is not reachable. Is `npm start` running on port 8787?',
  UNSUPPORTED: 'This gateway does not provide that API yet. Update the backend, or use mock mode.',
};

/** Readable text for notifications: "CODE: message" plus a hint when we have one. */
export function describe(error) {
  if (error instanceof ApiError) {
    const d = error.details ?? {};
    const stale = error.code === 'STALE' && d.currentRevision !== undefined
      ? ` You worked from revision ${d.expectedRevision}; Main is now at revision ${d.currentRevision}.` : '';
    return { title: `${error.code} · ${error.message}`, hint: `${HINTS[error.code] ?? ''}${stale}`.trim() };
  }
  return { title: error?.message ?? String(error), hint: '' };
}
