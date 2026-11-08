// Human-facing CLI for workspace supervision. All writes use AgentreeService.
import { basename } from 'node:path';
import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import { DomainError, type Actor, type Branch, type Session, type Workspace, type FileRef } from '../../../packages/contracts/src/index.js';
import { clip, eventSummary, short, table, time } from './format.js';
import { Gateway } from './gateway.js';
import { agentreeHome, Home } from './home.js';

export interface Io { out(text: string): void; err(text: string): void; env: NodeJS.ProcessEnv; cwd: string; }
export class CliError extends Error { constructor(readonly code: string, message: string, readonly hint?: string) { super(message); } }
const EXIT: Record<string, number> = { USAGE: 2, AMBIGUOUS: 2, DENY: 3, IDENTITY: 3, NOT_FOUND: 4, STALE: 5, STATE: 5, REVISION: 5, CONFLICT: 5 };
const HINTS: Record<string, string> = { DENY: 'This operation is not allowed for the current identity.', IDENTITY: 'Run this human governance command without --as <session>.', STALE: 'Main changed. Refresh the branch or Main view and retry.', NOT_FOUND: 'List current records with agentree status.' };
export const HELP = `agentree — supervision for independent coding agents

Run agentree with no arguments to start the Gateway and open the Console.

Usage: agentree <command> [options]  (global: --json --workspace <name|id> --db <path> --as <session>)

Workspace and native activity
  init <name> [--root id=path ...]       create and select a workspace
  workspace [show|list|use <name|id>]
  status                                 Main, branches, sessions and conflicts
  branch list|create <name>
  session list|register <branch> --agent <id> --runtime <runtime> --native <id>
  log [--session s] [--type t] [--source s] [--audit] [--after seq] [--limit n]

Supervision (all writes are human authorized)
  main                                   show active Main entries
  main add <body> [--file rootId=path ...]
  main edit <entry-id> <body> [--file rootId=path ...]
  main remove <entry-id>
  main history <entry-id>
  branch show <branch>
  work list <branch> | work accept <branch> <work-id...> | work reject <branch> <work-id...>
  conflict list | conflict decide <id> <confirmed|resolved|dismissed> <explanation>
  correction send <branch> <body>
  merge list

State uses $AGENTREE_HOME, else $GATEWAY_DATA_DIR, else ~/.local/share/agentree. IDs accept unique prefixes.`;
const OPTIONS = {
  json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, db: { type: 'string' }, workspace: { type: 'string', short: 'w' }, as: { type: 'string' },
  root: { type: 'string', multiple: true }, agent: { type: 'string' }, name: { type: 'string' }, runtime: { type: 'string' }, native: { type: 'string' },
  session: { type: 'string' }, type: { type: 'string' }, source: { type: 'string' }, audit: { type: 'boolean' }, after: { type: 'string' }, limit: { type: 'string' },
  file: { type: 'string', multiple: true },
} as const;
type Values = ReturnType<typeof parse>['values'];
const parse = (argv: string[]) => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
interface Ctx { io: Io; json: boolean; values: Values; pos: string[]; home: Home; gw: Gateway; }

export function run(argv: string[], io: Io): number {
  let ctx: Ctx | undefined; let json = argv.includes('--json');
  try {
    let parsed; try { parsed = parse(argv); } catch (error) { throw new CliError('USAGE', (error as Error).message, 'agentree --help'); }
    const { values, positionals } = parsed; json = !!values.json;
    if (values.help || !positionals.length || positionals[0] === 'help') { io.out(HELP); return 0; }
    if (io.env.HARNESS_SESSION_ID || io.env.HARNESS_SESSION_TOKEN)
      throw new DomainError('DENY', 'Managed sessions must use the session-bound Gateway or MCP client');
    const home = new Home(agentreeHome(io.env)); home.ensure(); const dbPath = values.db ?? home.dbPath;
    const humanId = io.env.AGENTREE_USER ?? userInfo().username;
    let gw = new Gateway(dbPath, { type: 'human', id: humanId });
    if (values.as) {
      const s = pickOne(gw.store.list<Session>('session'), values.as, 'session', (x) => [x.id, x.nativeId]); gw.close();
      gw = new Gateway(dbPath, { type: 'agent', sessionId: s.id } satisfies Actor);
    }
    ctx = { io, json, values, pos: positionals, home, gw }; dispatch(ctx); return 0;
  } catch (error) { return report(io, json, error); } finally { ctx?.gw.close(); }
}
function report(io: Io, json: boolean, error: unknown): number {
  const code = error instanceof DomainError || error instanceof CliError ? error.code : 'ERROR'; const message = error instanceof Error ? error.message : String(error); const hint = error instanceof CliError && error.hint ? error.hint : HINTS[code];
  if (json) io.out(JSON.stringify({ ok: false, error: { code, message, ...(hint ? { hint } : {}) } }, null, 2)); else { io.err(`error [${code}]: ${message}`); if (hint) io.err(`hint: ${hint}`); }
  return EXIT[code] ?? 1;
}
function emit(ctx: Ctx, data: unknown, text: () => string) { ctx.io.out(ctx.json ? JSON.stringify({ ok: true, data }, null, 2) : text()); }
function need(value: string | undefined, usage: string) { if (!value) throw new CliError('USAGE', `Missing argument. Usage: agentree ${usage}`); return value; }
function pickOne<T>(items: T[], input: string, label: string, keys: (item: T) => string[]): T {
  const exact = items.filter((item) => keys(item).includes(input)); if (exact.length === 1) return exact[0];
  const prefix = items.filter((item) => keys(item).some((k) => k.startsWith(input))); if (prefix.length === 1) return prefix[0];
  if (!prefix.length) throw new CliError('NOT_FOUND', `No ${label} matches "${input}"`); throw new CliError('AMBIGUOUS', `"${input}" matches ${prefix.length} ${label}s; use a longer id`);
}
function ws(ctx: Ctx): Workspace {
  const all = ctx.gw.workspaces(); const selected = ctx.values.workspace ?? ctx.io.env.AGENTREE_WORKSPACE ?? ctx.home.config().currentWorkspaceId;
  if (selected) return pickOne(all, selected, 'workspace', (w) => [w.id, w.name]); if (all.length === 1) return all[0];
  throw new CliError('USAGE', all.length ? 'No workspace selected' : 'No workspace yet', all.length ? 'agentree workspace use <name>' : 'agentree init <name>');
}
const branch = (ctx: Ctx, w: Workspace, id: string): Branch => pickOne(ctx.gw.service.branches(w.id), id, 'branch', (b) => [b.id, b.name]);
const session = (ctx: Ctx, w: Workspace, id: string): Session => pickOne(ctx.gw.sessions(w.id), id, 'session', (s) => [s.id, s.nativeId]);
function int(value: string | undefined, name: string): number | undefined { if (value === undefined) return undefined; const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw new CliError('USAGE', `--${name} must be a non-negative integer`); return n; }
function files(values: string[] | undefined): FileRef[] { return (values ?? []).map((spec) => { const n = spec.indexOf('='); if (n < 1 || n === spec.length - 1) throw new CliError('USAGE', `File must be rootId=path: ${spec}`); return { rootId: spec.slice(0, n), path: spec.slice(n + 1) }; }); }
function dispatch(ctx: Ctx) {
  const [cmd, sub] = ctx.pos;
  if (cmd === 'init') return init(ctx);
  if (cmd === 'workspace') return workspaceCmd(ctx, sub ?? 'show');
  if (cmd === 'status') return status(ctx);
  if (cmd === 'branch') return branchCmd(ctx, sub ?? 'list');
  if (cmd === 'session') return sessionCmd(ctx, sub ?? 'list');
  if (cmd === 'log') return log(ctx);
  if (cmd === 'main') return mainCmd(ctx, sub ?? 'show');
  if (cmd === 'work') return workCmd(ctx, sub ?? 'list');
  if (cmd === 'conflict') return conflictCmd(ctx, sub ?? 'list');
  if (cmd === 'correction') return correctionCmd(ctx);
  if (cmd === 'merge') return mergeCmd(ctx);
  if (cmd === 'context') return branchShow(ctx, need(sub, 'context <branch>'));
  throw new CliError('USAGE', `Unknown command "${cmd}"`, 'agentree --help');
}
function init(ctx: Ctx) {
  const name = need(ctx.pos[1], 'init <name> [--root id=path ...]');
  const roots = (ctx.values.root ?? [ctx.io.cwd]).map((spec) => { const at = spec.indexOf('='); const path = at < 0 ? spec : spec.slice(at + 1); return { id: at < 0 ? basename(path) || 'root' : spec.slice(0, at), path }; });
  const created = ctx.gw.service.createWorkspace(name, roots); ctx.home.saveConfig({ ...ctx.home.config(), currentWorkspaceId: created.id });
  emit(ctx, created, () => `Created workspace ${created.name} (${short(created.id)}). Main is ready; next create a branch.`);
}
function workspaceCmd(ctx: Ctx, sub: string) {
  if (sub === 'list') { const current = ctx.home.config().currentWorkspaceId; const all = ctx.gw.workspaces(); return emit(ctx, all, () => table(['', 'name', 'id'], all.map((w) => [w.id === current ? '*' : '', w.name, short(w.id)]))); }
  if (sub === 'use') { const selected = pickOne(ctx.gw.workspaces(), need(ctx.pos[2], 'workspace use <name|id>'), 'workspace', (w) => [w.id, w.name]); ctx.home.saveConfig({ ...ctx.home.config(), currentWorkspaceId: selected.id }); return emit(ctx, selected, () => `Selected ${selected.name}`); }
  const current = ctx.gw.service.workspace(ws(ctx).id); return emit(ctx, current, () => `${current.name} (${current.id})\n${current.roots.map((r) => `root ${r.id}=${r.path}`).join('\n')}\nmain ${current.mainBranchId}`);
}
function status(ctx: Ctx) {
  const w = ws(ctx); const view = ctx.gw.service.supervision(w.id); const sessions = ctx.gw.sessions(w.id); const data = { main: view.main, branches: view.branches, conflicts: view.conflicts, sessions };
  emit(ctx, data, () => [`Workspace ${w.name}`, `Main revision ${view.main.revision} · ${view.main.entries.filter((e) => !e.removed).length} active entries`, '', table(['branch', 'sessions', 'proposals', 'activity'], view.branches.map((b) => [b.branch.name, b.sessions.length, b.work.filter((x) => x.state === 'proposed').length, b.recentActivity.length])), '', `Conflicts: ${view.conflicts.filter((c) => c.status === 'potential' || c.status === 'confirmed').length}`].join('\n'));
}
function branchCmd(ctx: Ctx, sub: string) {
  const w = ws(ctx); if (sub === 'list') { const list = ctx.gw.service.branches(w.id); return emit(ctx, list, () => table(['branch', 'id', 'revision'], list.map((b) => [b.name, short(b.id), b.revision]))); }
  if (sub === 'create') { const b = ctx.gw.service.createBranch(w.id, need(ctx.pos[2], 'branch create <name>')); return emit(ctx, b, () => `Created branch ${b.name} (${short(b.id)})`); }
  if (sub === 'show') return branchShow(ctx, need(ctx.pos[2], 'branch show <branch>'));
  throw new CliError('USAGE', `Unknown branch subcommand ${sub}`);
}
function branchShow(ctx: Ctx, input: string) {
  const w = ws(ctx); const b = branch(ctx, w, input); const view = ctx.gw.service.branchOverview(b.id);
  emit(ctx, view, () => [`Branch ${view.branch.name} (${short(view.branch.id)})`, 'Work:', ...view.work.map((x) => `  ${x.state} ${short(x.id)} ${clip(x.body, 90)}`), 'Files:', ...view.files.map((x) => `  ${x.rootId}:${x.path}`), 'Recent activity:', ...view.recentActivity.map((e) => `  #${e.sequence} ${time(e.occurredAt)} ${e.type} ${eventSummary(e)}`), 'Corrections:', ...view.corrections.map((x) => `  ${clip(x.body, 90)}`)].join('\n'));
}
function sessionCmd(ctx: Ctx, sub: string) {
  const w = ws(ctx); if (sub === 'list') { const branches = ctx.gw.service.branches(w.id); const list = ctx.gw.sessions(w.id); return emit(ctx, list, () => table(['session', 'runtime', 'native id', 'branch'], list.map((s) => [short(s.id), s.runtime, s.nativeId, branches.find((b) => b.id === s.branchId)?.name ?? short(s.branchId)]))); }
  if (sub === 'register') { const use = 'session register <branch> --agent <id> --runtime <runtime> --native <native-id>'; const b = branch(ctx, w, need(ctx.pos[2], use)); const a = need(ctx.values.agent, use); const s = ctx.gw.service.registerSession(b.id, { id: a, name: ctx.values.name ?? a }, need(ctx.values.runtime, use), need(ctx.values.native, use)); return emit(ctx, s, () => `Registered ${s.runtime}:${s.nativeId} on ${b.name}`); }
  throw new CliError('USAGE', `Unknown session subcommand ${sub}`);
}
function log(ctx: Ctx) {
  const w = ws(ctx); const id = ctx.values.session ? session(ctx, w, ctx.values.session).id : undefined;
  const page = ctx.gw.service.events(w.id, { afterSequence: int(ctx.values.after, 'after'), limit: int(ctx.values.limit, 'limit') ?? 100, ...(id ? { sessionId: id } : {}), ...(ctx.values.type ? { type: ctx.values.type } : {}), ...(ctx.values.audit ? { source: 'gateway' } : ctx.values.source ? { source: ctx.values.source } : {}) });
  emit(ctx, page, () => table(['seq', 'time', 'source', 'type', 'summary'], page.events.map((e) => [`#${e.sequence}`, time(e.occurredAt), e.source, e.type, eventSummary(e)])) + (page.hasMore ? `\nmore: --after ${page.nextSequence}` : ''));
}
function mainCmd(ctx: Ctx, sub: string) {
  const w = ws(ctx); const snapshot = ctx.gw.service.main(w.id);
  if (sub === 'show' || sub === undefined) return emit(ctx, snapshot, () => [`Main revision ${snapshot.revision}`, ...snapshot.entries.filter((e) => !e.removed).map((e) => `${short(e.id)} ${clip(e.body, 120)}${e.files.length ? ` [${e.files.map((f) => `${f.rootId}:${f.path}`).join(', ')}]` : ''}`)].join('\n'));
  if (sub === 'add') { const body = need(ctx.pos.slice(2).join(' '), 'main add <body> [--file rootId=path]'); const entry = ctx.gw.service.editMain(w.id, { body, files: files(ctx.values.file) }, snapshot.revision); return emit(ctx, entry, () => `Added Main entry ${short(entry.id)} at revision ${entry.revision}`); }
  if (sub === 'edit' || sub === 'remove') {
    const id = need(ctx.pos[2], `main ${sub} <entry-id>${sub === 'edit' ? ' <body>' : ''}`); const entry = pickOne(snapshot.entries, id, 'Main entry', (x) => [x.id]);
    const result = sub === 'remove' ? ctx.gw.service.editMain(w.id, { body: entry.body, files: entry.files }, snapshot.revision, entry.id, true) : ctx.gw.service.editMain(w.id, { body: need(ctx.pos.slice(3).join(' '), 'main edit <entry-id> <body>'), files: ctx.values.file ? files(ctx.values.file) : entry.files }, snapshot.revision, entry.id);
    return emit(ctx, result, () => `${sub === 'remove' ? 'Removed' : 'Updated'} Main entry ${short(result.id)} at revision ${result.revision}`);
  }
  if (sub === 'history') { const entryId = need(ctx.pos[2], 'main history <entry-id>'); const history = ctx.gw.service.mainHistory(w.id, entryId); return emit(ctx, history, () => history.map((x) => `rev ${x.revision} ${x.removed ? 'removed' : 'active'} ${x.actor.type === 'human' ? x.actor.id : x.actor.sessionId} ${clip(x.body, 100)}`).join('\n')); }
  throw new CliError('USAGE', `Unknown main command ${sub}`);
}
function workCmd(ctx: Ctx, sub: string) {
  const w = ws(ctx); const b = branch(ctx, w, need(ctx.pos[2], `work ${sub} <branch> [work-id...]`)); const overview = ctx.gw.service.branchOverview(b.id);
  if (sub === 'list') return emit(ctx, overview.work, () => table(['state', 'id', 'work'], overview.work.map((x) => [x.state, short(x.id), clip(x.body, 100)])));
  if (sub === 'accept' || sub === 'reject') {
    const ids = ctx.pos.slice(3).map((id) => pickOne(overview.work, id, 'work item', (x) => [x.id]).id); if (!ids.length) throw new CliError('USAGE', `Usage: agentree work ${sub} <branch> <work-id...>`);
    const revision = ctx.gw.service.main(w.id).revision; const result = ctx.gw.service.decideMerge(b.id, ids, sub === 'accept' ? 'accepted' : 'rejected', revision);
    return emit(ctx, result, () => `${sub === 'accept' ? 'Accepted into Main' : 'Rejected'} ${ids.length} work item(s); Main revision ${result.mainRevision}`);
  }
  throw new CliError('USAGE', `Unknown work command ${sub}`);
}
function conflictCmd(ctx: Ctx, sub: string) {
  const w = ws(ctx); if (sub === 'list') { const conflicts = ctx.gw.service.conflicts(w.id); return emit(ctx, conflicts, () => table(['status', 'id', 'branches', 'Main entry', 'evidence', 'explanation'], conflicts.map((c) => [c.status, short(c.id), c.branchIds.map(short).join(','), c.mainEntryId ? short(c.mainEntryId) : '-', c.evidenceIds.length, clip(c.explanation, 70)]))); }
  if (sub === 'decide') { const id = need(ctx.pos[2], 'conflict decide <id> <status> <explanation>'); const status = need(ctx.pos[3], 'conflict decide <id> <status> <explanation>') as 'confirmed' | 'resolved' | 'dismissed'; const explanation = need(ctx.pos.slice(4).join(' '), 'conflict decide <id> <status> <explanation>'); const result = ctx.gw.service.decideConflict(w.id, id, status, explanation); return emit(ctx, result, () => `Conflict ${short(result.id)} → ${result.status}`); }
  throw new CliError('USAGE', `Unknown conflict command ${sub}`);
}
function correctionCmd(ctx: Ctx) {
  if (ctx.pos[1] !== 'send') throw new CliError('USAGE', 'Usage: agentree correction send <branch> <body>');
  const w = ws(ctx); const b = branch(ctx, w, need(ctx.pos[2], 'correction send <branch> <body>')); const correction = ctx.gw.service.sendCorrection(b.id, need(ctx.pos.slice(3).join(' '), 'correction send <branch> <body>')); return emit(ctx, correction, () => `Correction sent to ${b.name} (${short(correction.id)})`);
}
function mergeCmd(ctx: Ctx) {
  if (ctx.pos[1] !== undefined && ctx.pos[1] !== 'list') throw new CliError('USAGE', 'Usage: agentree merge list');
  const w = ws(ctx); const merges = ctx.gw.service.merges(w.id); return emit(ctx, merges, () => table(['state', 'id', 'branch', 'work items', 'Main revision'], merges.map((m) => [m.state, short(m.id), ctx.gw.service.branches(w.id).find((b) => b.id === m.sourceBranchId)?.name ?? short(m.sourceBranchId), m.workIds.length, m.mainRevision])));
}
