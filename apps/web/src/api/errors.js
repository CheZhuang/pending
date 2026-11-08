// Gateway errors as the UI sees them: HTTP status + gateway code + message.
// Both the live client and the mock throw this, so views handle one shape.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const HINTS = {
  UNAUTHORIZED: 'Pair this browser with the admin token first.',
  DENY: 'The gateway refused this for the current credential. The refusal is in the audit log.',
  STATE: 'Someone already decided this. The list has been refreshed.',
  STALE: 'Main changed since you opened this edit. Reload, review the latest reference, then retry.',
  NETWORK: 'The gateway is not reachable. Is `npm start` running on port 8787?',
};

/** Readable text for notifications: "CODE: message" plus a hint when we have one. */
export function describe(error) {
  if (error instanceof ApiError) {
    return { title: `${error.code} · ${error.message}`, hint: HINTS[error.code] ?? '' };
  }
  return { title: error?.message ?? String(error), hint: '' };
}
