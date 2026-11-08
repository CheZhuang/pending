// Small display helpers shared by the views (mirrors apps/cli/src/format.ts).

export const short = (id) => (id ? String(id).slice(0, 8) : '—');

export function clip(text, max = 80) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function time(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso ?? '') : d.toLocaleTimeString([], { hour12: false });
}

export function dateTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso ?? '') : d.toLocaleString([], { hour12: false });
}

const rec = (v) => (v && typeof v === 'object' ? v : {});
const str = (v) => (typeof v === 'string' ? v : '');

export function actorText(actor) {
  const a = rec(actor);
  if (a.type === 'human') return `human:${str(a.id)}`;
  if (a.type === 'agent') return `agent:${short(a.sessionId)}`;
  return typeof actor === 'string' ? actor : '?';
}

/** Tool name + main argument for an event or approval input. */
export function toolTarget(input) {
  const i = rec(input);
  return str(i.file_path) || str(i.command) || str(i.path) || str(i.url) || str(i.pattern) || '';
}

/** One-line, human-readable summary of an observed or gateway event. */
export function eventSummary(e) {
  const p = rec(e.payload);
  switch (e.type) {
    case 'policy.decision':
      return `${actorText(p.actor)} ${str(p.operation)} → ${str(p.outcome).toUpperCase()}${p.outcome === 'allow' ? '' : ` (${str(p.reason)})`}`;
    case 'main.created': case 'main.updated': case 'main.removed': return `Main reference ${str(p.removed ? 'removed' : 'saved')} · revision ${p.revision ?? '?'}`;
    case 'work.proposed': return `Work proposed: ${clip(str(p.body), 70)}`;
    case 'merge.decided': return `Work ${str(p.state)} into Main · revision ${p.mainRevision ?? '?'}`;
    case 'conflict.reported': case 'conflict.decided': {
      const conflict = rec(p.conflict ?? p);
      return `Conflict ${str(conflict.status)}: ${clip(str(conflict.explanation), 65)}`;
    }
    case 'correction.sent': return `Correction sent to branch ${short(p.branchId)}`;
    case 'tool.pending':
      return `${str(p.tool)} ${clip(toolTarget(p.input), 60)} · waiting for a human`;
    case 'tool.decided':
      return `approval ${short(p.approvalId)} → ${str(p.state)}${p.reason ? ` (${str(p.reason)})` : ''}`;
    case 'tool.execution-decision':
      return `approval ${short(p.approvalId)} returned ${str(p.outcome).toUpperCase()} to the hook`;
    case 'session.registered':
      return `${str(p.runtime)}:${str(p.nativeId)} on branch ${short(p.branchId)}`;
    case 'session.kill-requested':
      return 'stop requested by a human';
    case 'session.exited':
      return `process exited${p.exitCode !== undefined ? ` (code ${p.exitCode})` : ''}${p.signal ? ` signal ${p.signal}` : ''}`;
    case 'branch.created':
      return `branch ${str(p.name)}`;
    case 'workspace.created':
      return `workspace ${str(p.name)}`;
    case 'main.restored': return `Main entry restored from revision ${rec(p.restoredFrom).revision ?? '?'} · now revision ${p.revision ?? '?'}`;
    default: {
      if (e.type?.startsWith('task.')) return `task ${short(p.taskId)} → ${str(p.status)}${p.nativeTurnId ? ` · turn ${short(p.nativeTurnId)}` : ''}${p.reason ? ` (${clip(str(p.reason), 60)})` : ''}`;
      const turn = rec(rec(p.params).turn);
      if (str(p.method).startsWith('turn/') && str(turn.id)) return `${str(p.method)} · turn ${short(turn.id)}${turn.status ? ` · ${str(turn.status)}` : ''}`;
      const tool = str(p.tool_name) || str(p.tool);
      const input = p.tool_input ?? p.input;
      if (tool) return `${tool} ${clip(toolTarget(input) || str(p.command), 70)}`.trim();
      const item = rec(rec(p.params).item);
      if (Array.isArray(item.changes)) return `${str(item.type) || 'change'} ${item.changes.map((c) => str(rec(c).path)).join(', ')}`;
      if (str(item.command)) return `${str(item.type) || 'command'} $ ${clip(item.command, 60)}`;
      if (str(p.text)) return `"${clip(p.text, 70)}"`;
      if (str(rec(p.params).delta)) return `"${clip(rec(p.params).delta, 70)}"`;
      if (str(p.method)) return str(p.method);
      return clip(JSON.stringify(e.payload ?? null), 90);
    }
  }
}

/** Distinguish telemetry, runtime-reported results, and Gateway interception records. */
export function eventEvidence(e) {
  if (e.mode === 'controlled' && e.source === 'gateway' && (e.type === 'tool.pending' || e.type === 'tool.decided' || e.type === 'tool.execution-decision')) return 'Intercepted tool decision';
  if (e.mode === 'observed' && (e.type === 'tool.result' || e.type === 'tool.failed' || e.type === 'item/completed')) return 'Runtime-reported result';
  if (e.mode === 'observed') return 'Observed';
  return 'Gateway record';
}

/** Tag color for an event row. */
export function eventTone(e) {
  const p = rec(e.payload);
  if (e.type === 'policy.decision') return p.outcome === 'deny' ? 'error' : p.outcome === 'allow' ? 'success' : 'warning';
  if (e.type === 'tool.pending') return 'warning';
  if (e.type === 'tool.decided') return p.state === 'approved' ? 'success' : 'error';
  if (e.type.startsWith('session.kill') || e.type === 'session.exited') return 'error';
  return e.mode === 'controlled' ? 'info' : 'default';
}
