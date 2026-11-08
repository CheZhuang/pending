// Display rules for human-dispatched tasks (docs/TASK_DISPATCH_API.md).
// Statuses come from the Gateway; this file only explains them and finds the
// native evidence the Gateway already recorded. It never advances a status.

export const TASK_STATUS = {
  submitted: { label: 'Submitted', tone: 'default', meaning: 'Recorded by the Gateway; no runner has claimed it yet.' },
  'delivery-pending': { label: 'Delivering', tone: 'info', meaning: 'A managed native runner claimed the task and is starting a turn.' },
  'native-accepted': { label: 'Accepted', tone: 'info', meaning: 'The native runtime returned a turn id (turn/start).' },
  running: { label: 'Running', tone: 'info', meaning: 'The native runtime reported turn/started for this turn.' },
  completed: { label: 'Completed', tone: 'success', meaning: 'The native runtime reported turn/completed. This is runtime evidence, not proof the work is correct.' },
  failed: { label: 'Failed', tone: 'error', meaning: 'The native runtime reported the turn ended without completing (including interruption).' },
  'delivery-unavailable': { label: 'Not deliverable', tone: 'warning', meaning: 'No supported delivery path for this session, or the runner reported failure before acceptance.' },
  'cancel-requested': { label: 'Cancelling', tone: 'warning', meaning: 'Interruption was requested; waiting for native evidence of the outcome.' },
  cancelled: { label: 'Cancelled', tone: 'default', meaning: 'Cancelled before it was delivered to the agent.' },
  'outcome-unknown': { label: 'Outcome unknown', tone: 'warning', meaning: 'A delivery was in flight when the Gateway restarted or the session ended. It is never retried automatically.' },
};

export const statusInfo = (status) => TASK_STATUS[status] ?? { label: status, tone: 'default', meaning: 'Unknown status reported by the Gateway.' };

/** Statuses the Gateway accepts a cancel for (before terminal native evidence). */
export const CANCELLABLE = new Set(['submitted', 'delivery-pending', 'native-accepted', 'running']);
export const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'delivery-unavailable', 'outcome-unknown']);

/** Can this session receive a task right now, and if not, why (shown before submitting). */
export function deliveryOf(session) {
  if (!session) return { ok: false, reason: 'Choose an agent session.' };
  if (session.state && session.state !== 'active') return { ok: false, reason: `Session is ${session.state}; tasks need an active session.` };
  if (session.runtime === 'claude-code') return { ok: false, reason: 'Claude Code CLI sessions cannot receive unsolicited tasks (native limitation). The Gateway would record it as not deliverable.' };
  if (session.taskDispatch?.available) return { ok: true, reason: 'Managed Codex runner is connected.' };
  if (session.runtime === 'codex-app-server') return { ok: false, reason: 'No managed Codex runner is polling for this session right now.' };
  return { ok: false, reason: `Runtime "${session.runtime}" has no supported task delivery.` };
}

/** Text sent to the agent: instructions, then optional human context under a clear heading. */
export function composeInstructions(instructions, context) {
  const main = String(instructions ?? '').trim();
  const extra = String(context ?? '').trim();
  return extra ? `${main}\n\nContext from the human supervisor:\n${extra}` : main;
}

const rec = (v) => (v && typeof v === 'object' ? v : {});
/** Native turn id referenced by an observed App Server notification, if any. */
export function turnIdOf(event) {
  const p = rec(rec(event.payload).params);
  return rec(p.turn).id ?? p.turnId ?? null;
}

/**
 * Evidence for one task from the event log: the Gateway's task.* records plus
 * native observed events of the same session that reference its turn id.
 */
export function taskEvidence(task, events) {
  return events.filter((e) => {
    if (e.type?.startsWith('task.') && rec(e.payload).taskId === task.id) return true;
    return !!task.nativeTurnId && e.mode === 'observed' && e.sessionId === task.sessionId && turnIdOf(e) === task.nativeTurnId;
  });
}
