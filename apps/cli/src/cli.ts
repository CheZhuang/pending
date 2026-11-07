// `agentree` human-facing CLI. `run(argv, io)` is pure enough to test: it
// returns an exit code and writes through `io`. Writes go through the Gateway
// (A's authorized service); `--json` gives scriptable output on every command.
import { basename } from 'node:path';
import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import {
  DomainError, type Actor, type Branch, type ConflictResolution, type MergeRequest, type Review, type Session, type Workspace,
} from '../../../packages/contracts/src/index.js';
import { authorityOf, type Level } from '../../../packages/sync/src/index.js';
import { clip, commitLine, eventSummary, scopeText, short, table, time } from './format.js';
import { Gateway } from './gateway.js';
import { agentreeHome, Home } from './home.js';

export interface Io {
  out(text: string): void;
  err(text: string): void;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export class CliError extends Error {
  constructor(readonly code: string, message: string, readonly hint?: string) {
    super(message);
  }
}

/** Exit codes: 0 ok · 1 failure · 2 usage · 3 not authorized · 4 not found · 5 stale/conflicting state. */
const EXIT: Record<string, number> = {
  USAGE: 2, AMBIGUOUS: 2, DENY: 3, 'REQUIRE-APPROVAL': 3, IDENTITY: 3, NOT_FOUND: 4,
  STALE: 5, STATE: 5, REVIEW: 5, REVISION: 5, RESOLUTION: 5, MERGE: 5,
};

const HINTS: Record<string, string> = {
  DENY: 'The gateway refused this operation for the current identity. The refusal is recorded: agentree log --type policy.decision',
  'REQUIRE-APPROVAL': 'This operation needs human approval first: agentree review list',
  IDENTITY: 'This command must be run by a human, not with --as <session>.',
  STALE: 'Context changed after the merge request was created. Ask the agent to create a new merge request.',
  STATE: 'It was already decided. Check: agentree review list --all',
  REVIEW: 'The merge needs an approved review: agentree review approve <id>',
  RESOLUTION: 'Choose existing or incoming for every conflict: --keep incoming|existing, or --pick <n>=existing|incoming',
  NOT_FOUND: 'List what exists with: agentree status',
};

export const HELP = `agentree — collaboration gateway for independent CLI agents

Usage: agentree <command> [options]       (global: --json  --workspace <name|id>  --db <path>  --as <session>)

Workspace
  init <name> [--root id=path ...]        create a workspace (default root: current directory) and select it
  workspace [show|list|use <name|id>]     show, list or select the current workspace
  status                                  branches, sessions, delivery states and pending reviews

Agents
  branch list | branch create <name> [--restricted]
  session list
  session register <branch> --agent <id> --runtime <claude|codex> --native <native-session-id> [--name <name>]

History
  log [--session s] [--type t] [--source s] [--audit] [--after seq] [--limit n]
  context <branch> [--history]            accepted / proposed context visible on a branch
  relevant <session> [--level signal|digest|full] [--budget tokens] [--fresh]
                                          preview what the next sync would deliver (nothing is marked delivered)

Review (all decisions are authorized and audited by the gateway)
  merge list [--all] | merge show <id> | merge apply <id>
  merge create <source-branch> <target-branch> <commit...>
  review list [--all] | review show <id>
  review approve <id> [--no-apply]        approve (incoming wins conflicts) and apply the merge
  review reject <id>
  review resolve <id> (--keep incoming|existing | --pick <n>=existing|incoming ...) [--no-apply]

State: $AGENTREE_HOME, else $GATEWAY_DATA_DIR, else ~/.local/share/agentree — the same gateway.sqlite the gateway daemon uses.
Ids accept unique prefixes; branches also accept names. Exit codes: 0 ok, 2 usage, 3 not authorized, 4 not found, 5 stale/conflict.`;

const OPTIONS = {
  json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  db: { type: 'string' }, workspace: { type: 'string', short: 'w' }, as: { type: 'string' },
  root: { type: 'string', multiple: true }, restricted: { type: 'boolean' },
  agent: { type: 'string' }, name: { type: 'string' }, runtime: { type: 'string' }, native: { type: 'string' },
  session: { type: 'string' }, type: { type: 'string' }, source: { type: 'string' }, audit: { type: 'boolean' },
  after: { type: 'string' }, limit: { type: 'string' }, history: { type: 'boolean' },
  level: { type: 'string' }, budget: { type: 'string' }, fresh: { type: 'boolean' }, all: { type: 'boolean' },
  keep: { type: 'string' }, pick: { type: 'string', multiple: true }, 'no-apply': { type: 'boolean' },
} as const;

type Values = ReturnType<typeof parse>['values'];
const parse = (argv: string[]) => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });

interface Ctx {
  io: Io;
  json: boolean;
  values: Values;
  pos: string[];
  home: Home;
  gw: Gateway;
}

export function run(argv: string[], io: Io): number {
  let ctx: Ctx | undefined;
  let json = argv.includes('--json');
  try {
    let parsed;
    try { parsed = parse(argv); } catch (error) { throw new CliError('USAGE', (error as Error).message, 'agentree --help'); }
    const { values, positionals } = parsed;
    json = !!values.json;
    if (values.help || positionals.length === 0 || positionals[0] === 'help') { io.out(HELP); return 0; }

    const home = new Home(agentreeHome(io.env));
    home.ensure();
    const dbPath = values.db ?? home.dbPath;
    const humanId = io.env.AGENTREE_USER ?? userInfo().username;
    let gw = new Gateway(dbPath, { type: 'human', id: humanId });
    if (values.as) {
      // Demo/testing affordance: act as a registered agent session to see gateway refusals.
      const session = pickOne(gw.store.list<Session>('session'), values.as, 'session', (s) => [s.id, s.nativeId]);
      gw.close();
      gw = new Gateway(dbPath, { type: 'agent', sessionId: session.id } satisfies Actor);
    }
    ctx = { io, json, values, pos: positionals, home, gw };
    dispatch(ctx);
    return 0;
  } catch (error) {
    return report(io, json, error);
  } finally {
    ctx?.gw.close();
  }
}

function report(io: Io, json: boolean, error: unknown): number {
  const code = error instanceof DomainError || error instanceof CliError ? error.code : 'ERROR';
  const message = error instanceof Error ? error.message : String(error);
  const hint = error instanceof CliError && error.hint ? error.hint : HINTS[code];
  if (json) io.out(JSON.stringify({ ok: false, error: { code, message, ...(hint ? { hint } : {}) } }, null, 2));
  else {
    io.err(`error [${code}]: ${message}`);
    if (hint) io.err(`hint: ${hint}`);
  }
  return EXIT[code] ?? 1;
}

function emit(ctx: Ctx, data: unknown, text: () => string): void {
  ctx.io.out(ctx.json ? JSON.stringify({ ok: true, data }, null, 2) : text());
}

function need(value: string | undefined, usage: string): string {
  if (!value) throw new CliError('USAGE', `Missing argument. Usage: agentree ${usage}`);
  return value;
}

/** Exact id/name match first, then a unique prefix. */
function pickOne<T>(items: T[], input: string, label: string, keys: (item: T) => string[]): T {
  const exact = items.filter((item) => keys(item).includes(input));
  if (exact.length === 1) return exact[0];
  const prefix = items.filter((item) => keys(item).some((k) => k.startsWith(input)));
  if (prefix.length === 1) return prefix[0];
  if (prefix.length === 0) throw new CliError('NOT_FOUND', `No ${label} matches "${input}"`);
  throw new CliError('AMBIGUOUS', `"${input}" matches ${prefix.length} ${label}s; use a longer id`);
}

function workspace(ctx: Ctx): Workspace {
  const all = ctx.gw.workspaces();
  const chosen = ctx.values.workspace ?? ctx.io.env.AGENTREE_WORKSPACE ?? ctx.home.config().currentWorkspaceId;
  if (chosen) return pickOne(all, chosen, 'workspace', (w) => [w.id, w.name]);
  if (all.length === 1) return all[0];
  throw new CliError('USAGE', all.length ? 'No workspace selected' : 'No workspace yet', all.length ? 'agentree workspace use <name>' : 'agentree init <name>');
}

const branch = (ctx: Ctx, ws: Workspace, input: string): Branch =>
  pickOne(ctx.gw.service.branches(ws.id), input, 'branch', (b) => [b.id, b.name]);
const session = (ctx: Ctx, ws: Workspace, input: string): Session =>
  pickOne(ctx.gw.sessions(ws.id), input, 'session', (s) => [s.id, s.nativeId]);
const merge = (ctx: Ctx, ws: Workspace, input: string): MergeRequest =>
  pickOne(ctx.gw.merges(ws.id), input, 'merge request', (m) => [m.id]);
const review = (ctx: Ctx, ws: Workspace, input: string): { review: Review; merge: MergeRequest } =>
  pickOne(ctx.gw.reviews(ws.id), input, 'review', (r) => [r.review.id]);

function int(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new CliError('USAGE', `--${name} must be a non-negative integer`);
  return n;
}

function dispatch(ctx: Ctx): void {
  const [command, sub] = ctx.pos;
  switch (command) {
    case 'init': return init(ctx);
    case 'workspace': return workspaceCmd(ctx, sub ?? 'show');
    case 'status': return status(ctx);
    case 'branch': return branchCmd(ctx, sub ?? 'list');
    case 'session': return sessionCmd(ctx, sub ?? 'list');
    case 'log': return log(ctx);
    case 'context': return context(ctx);
    case 'relevant': return relevant(ctx);
    case 'merge': return mergeCmd(ctx, sub ?? 'list');
    case 'review': return reviewCmd(ctx, sub ?? 'list');
    default: throw new CliError('USAGE', `Unknown command "${command}"`, 'agentree --help');
  }
}

// ---------------- workspace ----------------

function init(ctx: Ctx): void {
  const name = need(ctx.pos[1], 'init <name> [--root id=path ...]');
  const roots = (ctx.values.root ?? [ctx.io.cwd]).map((spec) => {
    const at = spec.indexOf('=');
    const path = at === -1 ? spec : spec.slice(at + 1);
    return { id: at === -1 ? basename(path) || 'root' : spec.slice(0, at), path };
  });
  const ws = ctx.gw.service.createWorkspace(name, roots);
  ctx.home.saveConfig({ ...ctx.home.config(), currentWorkspaceId: ws.id });
  emit(ctx, ws, () => [
    `Created workspace ${ws.name} (${short(ws.id)}) and selected it.`,
    ...ws.roots.map((r) => `  root ${r.id} = ${r.path}`),
    `  main branch ${short(ws.mainBranchId)} (protected: human-reviewed merges only)`,
    'Next: agentree branch create <name>',
  ].join('\n'));
}

function workspaceCmd(ctx: Ctx, sub: string): void {
  if (sub === 'list') {
    const current = ctx.home.config().currentWorkspaceId;
    const all = ctx.gw.workspaces();
    return emit(ctx, all, () => table(['', 'name', 'id', 'roots'], all.map((w) => [w.id === current ? '*' : '', w.name, short(w.id), w.roots.map((r) => `${r.id}=${r.path}`).join(' ')])));
  }
  if (sub === 'use') {
    const ws = pickOne(ctx.gw.workspaces(), need(ctx.pos[2], 'workspace use <name|id>'), 'workspace', (w) => [w.id, w.name]);
    ctx.home.saveConfig({ ...ctx.home.config(), currentWorkspaceId: ws.id });
    return emit(ctx, ws, () => `Selected workspace ${ws.name} (${short(ws.id)})`);
  }
  if (sub === 'show') {
    const ws = ctx.gw.service.workspace(workspace(ctx).id);
    return emit(ctx, ws, () => [`${ws.name} (${ws.id})`, ...ws.roots.map((r) => `  root ${r.id} = ${r.path}`), `  main ${ws.mainBranchId}`].join('\n'));
  }
  throw new CliError('USAGE', `Unknown workspace subcommand "${sub}"`);
}

function status(ctx: Ctx): void {
  const ws = workspace(ctx);
  const branches = ctx.gw.service.branches(ws.id);
  const sessions = ctx.gw.sessions(ws.id);
  const sync = ctx.gw.sync();
  const delivery = sessions.map((s) => ({ session: s, counts: sync.status(s.id).counts }));
  const pending = ctx.gw.reviews(ws.id).filter((r) => r.review.state === 'pending');
  const openMerges = ctx.gw.merges(ws.id).filter((m) => m.state === 'pending');
  const branchName = (id: string) => branches.find((b) => b.id === id)?.name ?? short(id);
  const data = { workspace: ws, branches, sessions: delivery, pendingReviews: pending.map((r) => r.review), openMerges };
  emit(ctx, data, () => [
    `Workspace ${ws.name} (${short(ws.id)})   roots: ${ws.roots.map((r) => `${r.id}=${r.path}`).join(' ') || '-'}`,
    '',
    'Branches',
    table(['name', 'id', 'revision', 'sessions', ''], branches.map((b) => [
      b.name, short(b.id), b.revision,
      sessions.filter((s) => s.branchId === b.id).map((s) => `${s.runtime}:${short(s.id)}`).join(' ') || '-',
      b.id === ws.mainBranchId ? 'protected · shared context' : b.restricted ? 'restricted' : '',
    ])),
    '',
    'Sessions (context delivery)',
    table(['session', 'agent', 'runtime', 'branch', 'pending', 'delivered', 'acked'], delivery.map(({ session: s, counts }) => [
      short(s.id), ctx.gw.agentName(s.agentId), `${s.runtime}:${s.nativeId}`, branchName(s.branchId), counts.pending, counts.delivered, counts.acknowledged,
    ])),
    '',
    `Pending reviews: ${pending.length}${pending.length ? '   → agentree review list' : ''}    Open merge requests: ${openMerges.length}`,
  ].join('\n'));
}

// ---------------- agents ----------------

function branchCmd(ctx: Ctx, sub: string): void {
  const ws = workspace(ctx);
  if (sub === 'list') {
    const branches = ctx.gw.service.branches(ws.id);
    return emit(ctx, branches, () => table(['name', 'id', 'revision', 'flags'], branches.map((b) => [
      b.name, short(b.id), b.revision, b.id === ws.mainBranchId ? 'main,protected' : b.restricted ? 'restricted' : '',
    ])));
  }
  if (sub === 'create') {
    const b = ctx.gw.service.createBranch(ws.id, need(ctx.pos[2], 'branch create <name> [--restricted]'), !!ctx.values.restricted);
    return emit(ctx, b, () => `Created branch ${b.name} (${short(b.id)}) — inherits accepted context from main.`);
  }
  throw new CliError('USAGE', `Unknown branch subcommand "${sub}"`);
}

function sessionCmd(ctx: Ctx, sub: string): void {
  const ws = workspace(ctx);
  if (sub === 'list') {
    const branches = ctx.gw.service.branches(ws.id);
    const sessions = ctx.gw.sessions(ws.id);
    return emit(ctx, sessions, () => table(['session', 'agent', 'runtime', 'native id', 'branch'], sessions.map((s) => [
      short(s.id), ctx.gw.agentName(s.agentId), s.runtime, s.nativeId, branches.find((b) => b.id === s.branchId)?.name ?? short(s.branchId),
    ])));
  }
  if (sub === 'register') {
    const usage = 'session register <branch> --agent <id> --runtime <runtime> --native <id> [--name <name>]';
    const b = branch(ctx, ws, need(ctx.pos[2], usage));
    const agentId = need(ctx.values.agent, usage);
    const s = ctx.gw.service.registerSession(b.id, { id: agentId, name: ctx.values.name ?? agentId }, need(ctx.values.runtime, usage), need(ctx.values.native, usage));
    return emit(ctx, s, () => `Registered session ${short(s.id)} (${s.runtime}:${s.nativeId}) on branch ${b.name}.`);
  }
  throw new CliError('USAGE', `Unknown session subcommand "${sub}"`);
}

// ---------------- history ----------------

function log(ctx: Ctx): void {
  const ws = workspace(ctx);
  const v = ctx.values;
  const sessionId = v.session ? session(ctx, ws, v.session).id : undefined;
  const page = ctx.gw.service.events(ws.id, {
    afterSequence: int(v.after, 'after'), limit: int(v.limit, 'limit') ?? 100,
    ...(sessionId ? { sessionId } : {}), ...(v.type ? { type: v.type } : {}),
    ...(v.audit ? { source: 'gateway' } : v.source ? { source: v.source } : {}),
  });
  emit(ctx, page, () => {
    const rows = page.events.map((e) => [`#${e.sequence}`, time(e.occurredAt), e.mode === 'controlled' ? 'gateway' : clip(e.source, 24), e.type, eventSummary(e)]);
    const more = page.hasMore ? `\n… more: agentree log --after ${page.nextSequence}` : '';
    return table(['seq', 'time', 'source', 'type', 'summary'], rows) + more;
  });
}

function context(ctx: Ctx): void {
  const ws = workspace(ctx);
  const b = branch(ctx, ws, need(ctx.pos[1], 'context <branch> [--history]'));
  const snap = ctx.gw.service.snapshot(b.id);
  const inForce = new Set(snap.knowledge.map((c) => c.id));
  const entries = ctx.values.history ? snap.entries : snap.entries.filter((e) => inForce.has(e.commit.id));
  const rows = entries.map((e) => {
    const onMain = e.branchId === ws.mainBranchId;
    let label: string = authorityOf(e.commit, onMain, inForce.has(e.commit.id));
    if (!onMain && e.commit.knowledge.kind === 'decision' && !inForce.has(e.commit.id)) label = 'proposed (shadowed by main)';
    return { entry: e, label };
  });
  emit(ctx, { branch: b, revision: snap.revision, items: rows.map((r) => ({ authority: r.label, ...r.entry })) }, () => [
    `Context on ${b.name} (branch rev ${snap.revision.branchRevision}, main rev ${snap.revision.mainRevision})`,
    table(['status', 'commit', 'kind', 'key', 'scope', 'by', 'body'], rows.map(({ entry: e, label }) => [
      label, short(e.commit.id), e.commit.knowledge.kind, e.commit.knowledge.key,
      scopeText(e.commit.knowledge.scope) + (e.commit.knowledge.impactScope ? ` → ${scopeText(e.commit.knowledge.impactScope)}` : ''),
      short(e.commit.provenance.sessionId), clip(e.commit.knowledge.body, 50),
    ])),
  ].join('\n'));
}

function relevant(ctx: Ctx): void {
  const ws = workspace(ctx);
  const s = session(ctx, ws, need(ctx.pos[1], 'relevant <session> [--level l] [--budget n] [--fresh]'));
  const level = (ctx.values.level ?? 'digest') as Level;
  if (!['signal', 'digest', 'full'].includes(level)) throw new CliError('USAGE', '--level must be signal, digest or full');
  const preview = ctx.gw.preview(!!ctx.values.fresh);
  const focus = preview.focusFor(s);
  const delta = preview.prepare({ session: s, focus, level, budgetTokens: int(ctx.values.budget, 'budget') });
  emit(ctx, { focus, delta }, () => [
    `Focus of ${short(s.id)} (${s.runtime}:${s.nativeId})`,
    table(['source', 'scope', 'weight'], focus.entries.slice(0, 12).map((e) => [e.source, scopeText(e.scope), e.weight])),
    '',
    `Would deliver ${delta.items.length} item(s) at ${delta.level} level, ${delta.stats.tokens}/${delta.stats.budgetTokens} tokens` +
      ` · filtered as unrelated: ${delta.stats.filtered} · deferred by budget: ${delta.stats.deferred} · unacknowledged: ${delta.unacknowledged}`,
    table(['authority', 'key', 'scope', 'via', 'match', 'score', 'body'], delta.items.map((i) => [
      i.authority, i.key, scopeText(i.scope), i.relevance.via, i.relevance.match, i.relevance.score, clip(i.body ?? '', 50),
    ])),
    ctx.values.fresh ? '(--fresh: ignoring previous deliveries)' : '(preview only: nothing was marked delivered)',
  ].join('\n'));
}

// ---------------- review ----------------

function mergeRows(ctx: Ctx, ws: Workspace, merges: MergeRequest[]) {
  const names = new Map(ctx.gw.service.branches(ws.id).map((b) => [b.id, b.name]));
  return table(['merge', 'state', 'from', 'to', 'commits', 'review'], merges.map((m) => [
    short(m.id), m.state, names.get(m.sourceBranchId) ?? short(m.sourceBranchId), names.get(m.targetBranchId) ?? short(m.targetBranchId),
    m.commitIds.length, m.reviewId ? short(m.reviewId) : 'none',
  ]));
}

function mergeCmd(ctx: Ctx, sub: string): void {
  const ws = workspace(ctx);
  if (sub === 'list') {
    const merges = ctx.gw.merges(ws.id).filter((m) => ctx.values.all || m.state === 'pending');
    return emit(ctx, merges, () => mergeRows(ctx, ws, merges));
  }
  if (sub === 'show') {
    const m = merge(ctx, ws, need(ctx.pos[2], 'merge show <id>'));
    const commits = m.commitIds.map((id) => ctx.gw.commit(ws.id, id));
    return emit(ctx, { merge: m, commits }, () => [mergeRows(ctx, ws, [m]), '', ...commits.map((c) => `  ${short(c.id)}  ${commitLine(c)}`)].join('\n'));
  }
  if (sub === 'create') {
    const usage = 'merge create <source-branch> <target-branch> <commit...>';
    const source = branch(ctx, ws, need(ctx.pos[2], usage));
    const target = branch(ctx, ws, need(ctx.pos[3], usage));
    const visible = ctx.gw.service.snapshot(source.id).history;
    const commitIds = ctx.pos.slice(4).map((input) => pickOne(visible, input, 'commit', (c) => [c.id]).id);
    if (!commitIds.length) throw new CliError('USAGE', `Missing commits. Usage: agentree ${usage}`);
    const token = ctx.gw.service.contextRevision(target.id);
    const m = ctx.gw.service.createMerge(source.id, target.id, commitIds, token.branchRevision, token.mainRevision);
    return emit(ctx, m, () => `Created merge ${short(m.id)} ${source.name} → ${target.name}` + (m.reviewId ? `; needs review ${short(m.reviewId)}` : '; no review needed — agentree merge apply ' + short(m.id)));
  }
  if (sub === 'apply') {
    const m = ctx.gw.service.applyMerge(merge(ctx, ws, need(ctx.pos[2], 'merge apply <id>')).id);
    return emit(ctx, m, () => `Applied merge ${short(m.id)}.`);
  }
  throw new CliError('USAGE', `Unknown merge subcommand "${sub}"`);
}

function reviewCmd(ctx: Ctx, sub: string): void {
  const ws = workspace(ctx);
  const names = () => new Map(ctx.gw.service.branches(ws.id).map((b) => [b.id, b.name]));
  if (sub === 'list') {
    const n = names();
    const reviews = ctx.gw.reviews(ws.id).filter((r) => ctx.values.all || r.review.state === 'pending');
    return emit(ctx, reviews, () => table(['review', 'state', 'merge', 'from → to', 'conflicts', 'decided by'], reviews.map(({ review: r, merge: m }) => [
      short(r.id), r.state, short(m.id), `${n.get(m.sourceBranchId)} → ${n.get(m.targetBranchId)}`, r.conflicts.length, r.decidedBy ?? '-',
    ])));
  }

  const target = review(ctx, ws, need(ctx.pos[2], `review ${sub} <id>`));
  if (sub === 'show') {
    const r = ctx.gw.service.review(target.review.id); // authorized review.read
    const m = target.merge;
    const n = names();
    const commits = m.commitIds.map((id) => ctx.gw.commit(ws.id, id));
    const conflicts = r.conflicts.map((c, i) => ({
      index: i + 1, key: c.key, existing: ctx.gw.commit(ws.id, c.existingCommitId), incoming: ctx.gw.commit(ws.id, c.incomingCommitId),
    }));
    return emit(ctx, { review: r, merge: m, commits, conflicts }, () => [
      `Review ${short(r.id)} · ${r.state}${r.decidedBy ? ` by ${r.decidedBy}` : ''} · merge ${short(m.id)} ${n.get(m.sourceBranchId)} → ${n.get(m.targetBranchId)}`,
      'Incoming commits:',
      ...commits.map((c) => `  ${short(c.id)}  ${commitLine(c)}  (by ${short(c.provenance.sessionId)})`),
      ...(conflicts.length ? ['', 'Conflicts (same key, overlapping impact, different body):'] : []),
      ...conflicts.flatMap((c) => [
        `  [${c.index}] ${c.key}`,
        `      existing ${short(c.existing.id)}  ${commitLine(c.existing)}`,
        `      incoming ${short(c.incoming.id)}  ${commitLine(c.incoming)}`,
      ]),
      '',
      r.state === 'pending'
        ? (conflicts.length ? `Decide: agentree review resolve ${short(r.id)} --keep incoming|existing   (or --pick 1=existing ...)` : `Decide: agentree review approve ${short(r.id)}   |   agentree review reject ${short(r.id)}`)
        : '',
    ].join('\n').trimEnd());
  }

  const applyAfter = (r: Review) => {
    if (ctx.values['no-apply'] || r.state !== 'approved') return { review: r };
    return { review: r, merge: ctx.gw.service.applyMerge(target.merge.id) };
  };
  const done = (verb: string) => (result: { review: Review; merge?: MergeRequest }) =>
    emit(ctx, result, () => `Review ${short(result.review.id)} ${verb} by ${result.review.decidedBy ?? 'you'}` + (result.merge ? `; merge ${short(result.merge.id)} applied — agents receive it on their next sync.` : '.'));

  if (sub === 'approve') return done('approved')(applyAfter(ctx.gw.service.resolveReview(target.review.id, 'approved')));
  if (sub === 'reject') return done('rejected')({ review: ctx.gw.service.resolveReview(target.review.id, 'rejected') });
  if (sub === 'resolve') {
    const resolutions = choose(target.review, ctx.values.keep, ctx.values.pick ?? []);
    return done('resolved')(applyAfter(ctx.gw.service.resolveReview(target.review.id, 'approved', resolutions)));
  }
  throw new CliError('USAGE', `Unknown review subcommand "${sub}"`);
}

/** Turn --keep / --pick flags into one explicit choice per conflict. */
function choose(r: Review, keep: string | undefined, picks: string[]): ConflictResolution[] {
  if (!r.conflicts.length) throw new CliError('USAGE', 'This review has no conflicts; use review approve or review reject');
  const side = (s: string | undefined) => {
    if (s === undefined || s === 'existing' || s === 'incoming') return s;
    throw new CliError('USAGE', `Choose "existing" or "incoming", not "${s}"`);
  };
  const defaults = side(keep);
  const chosen = new Map<number, 'existing' | 'incoming'>();
  for (const pick of picks) {
    const [n, s] = pick.split('=');
    const index = Number(n);
    if (!Number.isInteger(index) || index < 1 || index > r.conflicts.length) throw new CliError('USAGE', `--pick ${pick}: conflict number must be 1..${r.conflicts.length}`);
    chosen.set(index, side(s)!);
  }
  return r.conflicts.map((c, i) => {
    const s = chosen.get(i + 1) ?? defaults;
    if (!s) throw new CliError('RESOLUTION', `No choice for conflict ${i + 1} (${c.key})`);
    return { existingCommitId: c.existingCommitId, incomingCommitId: c.incomingCommitId, selectedCommitId: s === 'existing' ? c.existingCommitId : c.incomingCommitId };
  });
}
