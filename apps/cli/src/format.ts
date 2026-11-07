// Plain-text formatting for humans: aligned tables, short ids, one-line
// summaries of events. Every command also has a --json form for scripts.
import type { ContextCommit, Scope, SequencedEvent } from '../../../packages/contracts/src/index.js';

export const short = (id: string | undefined) => (id ? id.slice(0, 8) : '-');

export function scopeText(scope: Scope | undefined): string {
  if (!scope) return '-';
  if (scope.type === 'workspace') return 'workspace';
  if (scope.type === 'task') return `task:${scope.taskId}`;
  const root = scope.rootId ? `${scope.rootId}:` : '';
  return `${root}${scope.path}${scope.type === 'folder' && scope.path !== '.' ? '/' : ''}`;
}

export function clip(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Left-aligned columns separated by two spaces; header row in caps. */
export function table(headers: string[], rows: Array<Array<string | number>>): string {
  if (rows.length === 0) return '  (none)';
  const cells = [headers.map((h) => h.toUpperCase()), ...rows.map((r) => r.map(String))];
  const widths = headers.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? '').length)));
  return cells.map((r) => `  ${r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join('  ')}`.trimEnd()).join('\n');
}

export function time(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(11, 19);
}

export function commitLine(c: ContextCommit): string {
  const k = c.knowledge;
  const impact = k.impactScope ? ` → impacts ${scopeText(k.impactScope)}` : '';
  return `${k.kind} "${k.key}" @ ${scopeText(k.scope)}${impact}: ${clip(k.body)}`;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' ? (v as Rec) : {});
const str = (v: unknown) => (typeof v === 'string' ? v : '');

function actorText(actor: unknown): string {
  const a = rec(actor);
  return a.type === 'human' ? `human:${str(a.id)}` : a.type === 'agent' ? `agent:${short(str(a.sessionId))}` : '?';
}

/** One-line, human-readable summary of an observed or gateway event. */
export function eventSummary(e: SequencedEvent): string {
  const p = rec(e.payload);
  switch (e.type) {
    case 'policy.decision':
      return `${actorText(p.actor)} ${str(p.operation)} → ${str(p.outcome).toUpperCase()}${p.outcome === 'allow' ? '' : ` (${str(p.reason)})`}`;
    case 'context.published':
      return `${short(str(rec(p.provenance).sessionId))} published ${commitLine(p as unknown as ContextCommit)}`;
    case 'merge.created':
      return `merge ${short(str(p.id))} ${short(str(p.sourceBranchId))} → ${short(str(p.targetBranchId))} (${(p.commitIds as unknown[] | undefined)?.length ?? 0} commits)${p.reviewId ? ` review ${short(str(p.reviewId))}` : ''}`;
    case 'review.decided': {
      const r = rec(p.review);
      return `review ${short(str(r.id))} ${str(r.decision)} by ${actorText(p.actor)}${Array.isArray(r.resolutions) && r.resolutions.length ? ` (${r.resolutions.length} conflict choice(s))` : ''}`;
    }
    case 'merge.applied':
      return `merge ${short(str(rec(p.merge).id))} applied by ${actorText(p.actor)}`;
    case 'session.registered':
      return `session ${short(str(p.id))} ${str(p.runtime)}:${str(p.nativeId)} on branch ${short(str(p.branchId))}`;
    case 'branch.created':
      return `branch ${str(p.name)} (${short(str(p.id))})`;
    case 'workspace.created':
      return `workspace ${str(p.name)} (${short(str(p.id))})`;
    // Gateway tool-approval and session lifecycle records (src/gateway.ts).
    case 'tool.pending': {
      const input = rec(p.input);
      return `${str(p.tool)} ${clip(str(input.command) || str(input.file_path) || str(input.path) || JSON.stringify(p.input ?? null), 60)} · waiting for a human`;
    }
    case 'tool.decided':
      return `approval ${short(str(p.approvalId))} → ${str(p.state)}${p.reason && p.reason !== p.state ? ` (${clip(str(p.reason), 50)})` : ''} by ${str(p.actor) || '?'}`;
    case 'tool.execution-decision':
      return `hook told ${str(p.outcome).toUpperCase()} for approval ${short(str(p.approvalId))}`;
    case 'session.kill-requested':
      return 'stop requested by a human';
    case 'session.ended':
      return 'session ended';
    case 'session.exited':
      return `process exited${p.exitCode !== undefined && p.exitCode !== null ? ` with code ${String(p.exitCode)}` : ''}${p.signal ? ` by ${str(p.signal)}` : ''}`;
    default: {
      // Claude hooks use tool_name/tool_input; B's adapter records use tool/input.
      const tool = str(p.tool_name) || str(p.tool);
      const input = rec(p.tool_input ?? p.input);
      const target = str(input.file_path) || str(input.command) || str(input.path) || str(input.pattern) || str(p.command);
      if (tool) return `${tool} ${clip(target, 70)}`.trim();
      // Codex App Server notifications: { method, params: { item } }.
      const item = rec(rec(p.params).item);
      if (Array.isArray(item.changes)) return `${str(item.type) || 'change'} ${item.changes.map((c) => str(rec(c).path)).join(', ')}`;
      if (str(item.command)) return `${str(item.type) || 'command'} $ ${clip(str(item.command), 60)}`;
      if (str(p.method)) return str(p.method);
      if (str(p.text)) return `"${clip(str(p.text), 70)}"`;
      return clip(JSON.stringify(e.payload ?? null), 80);
    }
  }
}
