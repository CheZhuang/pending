// Small display helpers shared by the views (mirrors apps/cli/src/format.ts).

export const short = (id) => (id ? String(id).slice(0, 8) : '—');

export function scopeText(scope) {
  if (!scope) return '—';
  if (scope.type === 'workspace') return 'workspace';
  if (scope.type === 'task') return `task:${scope.taskId}`;
  const root = scope.rootId ? `${scope.rootId}:` : '';
  return `${root}${scope.path}${scope.type === 'folder' && scope.path !== '.' ? '/' : ''}`;
}

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
    case 'context.published': {
      const k = rec(p.knowledge);
      return `${str(k.kind)} "${str(k.key)}" @ ${scopeText(k.scope)}: ${clip(k.body, 60)}`;
    }
    case 'merge.created':
      return `merge ${short(p.id)} · ${(p.commitIds ?? []).length} commit(s)${p.reviewId ? ` · review ${short(p.reviewId)}` : ''}`;
    case 'merge.applied':
      return `merge ${short(rec(p.merge).id)} applied by ${actorText(p.actor)}`;
    case 'review.decided': {
      const r = rec(p.review);
      return `review ${short(r.id)} ${str(r.decision)} by ${actorText(p.actor)}`;
    }
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
    default: {
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

/** Tag color for an event row. */
export function eventTone(e) {
  const p = rec(e.payload);
  if (e.type === 'policy.decision') return p.outcome === 'deny' ? 'error' : p.outcome === 'allow' ? 'success' : 'warning';
  if (e.type === 'tool.pending') return 'warning';
  if (e.type === 'tool.decided') return p.state === 'approved' ? 'success' : 'error';
  if (e.type.startsWith('session.kill') || e.type === 'session.exited') return 'error';
  return e.mode === 'controlled' ? 'info' : 'default';
}
