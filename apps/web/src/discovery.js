// Overview rows: the Gateway's computer-wide process inventory (GET /v1/processes)
// merged with managed sessions (GET /v1/sessions). Discovery is metadata only: a
// process grants nothing by being found. Controls come from a managed session, and
// only the ones the Gateway reports or the integration declares are shown.
import { deliveryOf } from './task-status.js';

export const RUNTIME_NAMES = { 'claude-code': 'Claude Code', claude: 'Claude Code', codex: 'Codex', 'codex-app-server': 'Codex' };
export const runtimeName = (runtime) => RUNTIME_NAMES[runtime] ?? runtime ?? 'Unknown runtime';

/**
 * Approval paths declared by each managed integration (docs/NATIVE_AGENTS.md).
 * Declared, not measured: the Gateway does not report per-session capabilities.
 */
const DECLARED_APPROVALS = {
  'claude-code': 'Pre-execution hook: tool calls wait in Approvals',
  'codex-app-server': 'Native approval callbacks for selected actions only',
};

export const EVIDENCE_TEXT = {
  'executable-name': 'executable name',
  'known-installation-path': 'known installation path',
  'official-node-entrypoint': 'official Node entrypoint',
};

/** What a managed session supports right now, with a reason when it does not. */
export function sessionCapabilities(session) {
  const active = session.state === 'active';
  const delivery = deliveryOf(session);
  return {
    tasks: { available: active && delivery.ok, note: delivery.reason },
    approvals: { available: active && !!DECLARED_APPROVALS[session.runtime], note: DECLARED_APPROVALS[session.runtime] ?? 'No pre-execution approval path for this runtime' },
    stop: { available: active, note: active ? 'Requests termination through the launcher; the exit is shown once reported' : `Session is ${session.state ?? 'unknown'}` },
    activity: { available: true, note: 'Gateway records and runtime-reported events' },
  };
}

const NONE = Object.freeze({
  tasks: { available: false, note: 'Not a managed session' },
  approvals: { available: false, note: 'Not a managed session' },
  stop: { available: false, note: 'Not a managed session' },
  activity: { available: false, note: 'Discovery does not observe activity' },
});

/**
 * @param {{ inventory?: { status?: string, processes?: any[] } | null, sessions?: any[], workspaces?: any[] }} input
 * @returns {{ managed: any[], unmanaged: any[], ended: any[], unknownWorkspaceIds: string[] }}
 */
export function buildAgentRows({ inventory, sessions = [], workspaces = [] }) {
  const processes = inventory?.processes ?? [];
  const nameOf = (id) => workspaces.find((w) => w.id === id)?.name ?? null;
  const live = sessions.filter((s) => s.state !== 'ended');
  const liveIds = new Set(live.map((s) => s.id));
  const processFor = new Map(processes.filter((p) => p.managedSessionId && liveIds.has(p.managedSessionId)).map((p) => [p.managedSessionId, p]));

  const managed = live.map((session) => ({
    key: `session:${session.id}`,
    kind: 'managed',
    runtime: session.runtime,
    title: session.label || runtimeName(session.runtime),
    session,
    // Seen in the current OS scan and linked by launcher-reported identity.
    process: processFor.get(session.id) ?? null,
    // Launcher-reported identity alone does not prove the process is still running.
    reportedProcess: session.process ?? null,
    workspace: { id: session.workspaceId, name: nameOf(session.workspaceId) },
    capabilities: sessionCapabilities(session),
  }));
  const unmanaged = processes
    .filter((p) => !(p.managedSessionId && liveIds.has(p.managedSessionId)))
    .map((process) => ({
      key: `process:${process.id}`,
      kind: 'unmanaged',
      runtime: process.runtime,
      title: runtimeName(process.runtime),
      session: null,
      process,
      reportedProcess: null,
      workspace: null,
      capabilities: NONE,
    }));
  const known = new Set(workspaces.map((w) => w.id));
  const unknownWorkspaceIds = [...new Set(sessions.map((s) => s.workspaceId).filter((id) => id && !known.has(id)))];
  return { managed, unmanaged, ended: sessions.filter((s) => s.state === 'ended'), unknownWorkspaceIds };
}

/** One line describing an OS process sighting; missing fields are "unavailable", never guessed. */
export function processLine(process) {
  if (!process) return 'Not seen in the current process scan';
  const parts = [`PID ${process.pid}`];
  if (process.executable) parts.push(process.executable);
  parts.push(`identified by ${EVIDENCE_TEXT[process.evidence] ?? process.evidence}`);
  if (!process.identityReliable) parts.push('start time unavailable, identity may change between scans');
  return parts.join(' · ');
}
