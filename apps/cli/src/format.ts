// Compact text formatting for supervision records and the native activity log.
import type { SequencedEvent } from '../../../packages/contracts/src/index.js';
export const short = (id: string | undefined) => {
  if (!id) return '-';
  const namespaced = id.match(/^([^:]+):(.+)$/);
  return namespaced ? `${namespaced[1]}:${namespaced[2]!.slice(0, 8)}` : id.slice(0, 8);
};
export function clip(text: string, max = 60): string { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat; }
export function table(headers: string[], rows: Array<Array<string | number>>): string {
  if (!rows.length) return '  (none)'; const cells = [headers.map(h => h.toUpperCase()), ...rows.map(r => r.map(String))];
  const widths = headers.map((_, i) => Math.max(...cells.map(r => (r[i] ?? '').length)));
  return cells.map(r => `  ${r.map((c, i) => i === r.length - 1 ? c : c.padEnd(widths[i]!)).join('  ')}`.trimEnd()).join('\n');
}
export function time(iso: string): string { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(11, 19); }
type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => v && typeof v === 'object' ? v as Rec : {};
const str = (v: unknown) => typeof v === 'string' ? v : '';
function actorText(value: unknown) { const a = rec(value); return a.type === 'human' ? `human:${str(a.id)}` : a.type === 'agent' ? `agent:${short(str(a.sessionId))}` : '?'; }
export function eventSummary(e: SequencedEvent): string {
  const p = rec(e.payload);
  if (e.type === 'policy.decision') return `${actorText(p.actor)} ${str(p.operation)} → ${str(p.outcome).toUpperCase()}${p.outcome === 'allow' ? '' : ` (${str(p.reason)})`}`;
  if (e.type === 'work.proposed') return `${short(str(rec(p.work).sessionId))} proposed ${clip(str(rec(p.work).body), 70)}`;
  if (e.type === 'main.created' || e.type === 'main.updated' || e.type === 'main.removed') return `${e.type.slice(5)} Main entry ${short(str(p.id))}: ${clip(str(p.body), 60)}`;
  if (e.type === 'merge.decided') return `work ${str(rec(p.merge).state)} by ${actorText(p.actor)}`;
  if (e.type === 'conflict.decided' || e.type === 'conflict.reported') return `conflict ${str(rec(p.conflict).status)}: ${clip(str(rec(p.conflict).explanation), 60)}`;
  if (e.type === 'correction.sent') return `correction to ${short(str(p.branchId))}: ${clip(str(p.body), 60)}`;
  if (e.type === 'session.registered') return `session ${short(str(p.id))} ${str(p.runtime)}:${str(p.nativeId)} on branch ${short(str(p.branchId))}`;
  if (e.type === 'branch.created') return `branch ${str(p.name)} (${short(str(p.id))})`;
  const tool = str(p.tool_name) || str(p.tool); const input = rec(p.tool_input ?? p.input);
  const target = str(input.file_path) || str(input.command) || str(input.path) || str(input.pattern) || str(p.command);
  if (tool) return `${tool} ${clip(target, 70)}`.trim();
  const item = rec(rec(p.params).item); if (Array.isArray(item.changes)) return `${str(item.type) || 'change'} ${item.changes.map(c => str(rec(c).path)).join(', ')}`;
  if (str(item.command)) return `${str(item.type) || 'command'} $ ${clip(str(item.command), 60)}`;
  if (str(p.method)) return str(p.method); if (str(p.text)) return `"${clip(str(p.text), 70)}"`; return clip(JSON.stringify(e.payload ?? null), 80);
}
