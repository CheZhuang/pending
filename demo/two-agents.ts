// Reproducible two-agent Agentree demo. A Claude-like agent (auth work) and a
// Codex-like agent (API work) share scoped context through the real stack:
// B's adapter ingestion + MCP server, A's gateway/core/SQLite, C's sync + CLI.
// Native records are replayed fixtures, so the run needs no model or network.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Session } from '../packages/contracts/src/index.js';
import { AgentreeService } from '../packages/core/src/index.js';
import { SqliteStore } from '../packages/storage/src/index.js';
import { ingestNextBatch, MemoryCursorStore, MockAgentAdapter, type NativeRecord } from '../packages/adapters/src/index.js';
import { createAgentreeMcpServer } from '../packages/mcp/src/index.js';
import { ContextSync, EntityLedger, type ContextDelta } from '../packages/sync/src/index.js';
import { run } from '../apps/cli/src/cli.js';

export interface DemoIo {
  out(text: string): void;
}

const REPO = '/demo/repo'; // workspace root; only used as a path prefix, never read

const at = (s: number) => new Date(Date.UTC(2026, 10, 7, 10, 0, s)).toISOString();

/** Native Claude Code activity, in B's normalized adapter record shape. */
const claudeRecords: NativeRecord[] = [
  { nativeId: 'c-msg-1', type: 'user.message', occurredAt: at(1), payload: { text: 'Harden session token handling in src/auth' } },
  { nativeId: 'c-call-1', type: 'tool.call', occurredAt: at(2), payload: { tool: 'Read', input: { file_path: `${REPO}/src/auth/token.ts` } } },
  { nativeId: 'c-call-2', type: 'tool.call', occurredAt: at(3), payload: { tool: 'Grep', input: { pattern: 'verifyToken' } } },
  { nativeId: 'c-call-3', type: 'tool.call', occurredAt: at(4), payload: { tool: 'Edit', input: { file_path: `${REPO}/src/auth/session.ts` } } },
];

/** Native Codex App Server notifications (method + params), as B's adapter records them. */
const codexRecords: NativeRecord[] = [
  { nativeId: 'x-turn-1', type: 'turn/started', occurredAt: at(5), payload: { method: 'turn/started', params: { threadId: 'thread-api' } } },
  { nativeId: 'x-item-1', type: 'item/completed', occurredAt: at(6), payload: { method: 'item/completed', params: { item: { type: 'commandExecution', command: 'cat src/api/routes.ts' } } } },
  { nativeId: 'x-item-2', type: 'item/completed', occurredAt: at(7), payload: { method: 'item/completed', params: { item: { type: 'fileChange', changes: [{ path: `${REPO}/src/api/users.ts`, kind: 'update' }] } } } },
];

/** One agent as Agentree sees it: a registered session, its authorized service and an MCP client. */
class DemoAgent {
  private constructor(readonly label: string, readonly session: Session, readonly service: AgentreeService, private readonly mcp: Client, readonly sync: ContextSync) {}

  static async connect(label: string, store: SqliteStore, session: Session): Promise<DemoAgent> {
    // The daemon binds the identity; the MCP caller cannot choose who it is.
    const service = new AgentreeService(store, { type: 'agent', sessionId: session.id });
    const ledger = new EntityLedger(store);
    const server = createAgentreeMcpServer({ session, service, ledger });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: label, version: '0.0.0' });
    await server.connect(serverSide);
    await client.connect(clientSide);
    return new DemoAgent(label, session, service, client, new ContextSync(service, ledger));
  }

  /** Call one of B's MCP tools and unwrap `{ ok, data }`. */
  async tool<T = Record<string, unknown>>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await this.mcp.callTool({ name, arguments: args });
    const body = result.structuredContent as { ok: boolean; data?: T; error?: { code: string; message: string } };
    if (!body.ok) throw new Error(`${name} failed: ${body.error?.code} ${body.error?.message}`);
    return body.data as T;
  }

  /** Replay native records through B's adapter → A's ingestion (observed events). */
  async observe(runtime: string, records: NativeRecord[]): Promise<number> {
    const native = { runtime, nativeId: this.session.nativeId, cwd: REPO };
    const adapter = new MockAgentAdapter(runtime, [native], new Map([[native.nativeId, records]]));
    const binding = { ...native, sessionId: this.session.id, workspaceId: this.session.workspaceId, branchId: this.session.branchId };
    const cursors = new MemoryCursorStore();
    let count = 0;
    for (;;) {
      const batch = await ingestNextBatch(adapter, binding, cursors, { ingest: (e) => this.service.ingest(e) });
      count += batch.records.length;
      if (!batch.hasMore) return count;
    }
  }

  async close(): Promise<void> {
    await this.mcp.close();
  }
}

export interface DemoResult {
  home: string;
  deliveries: Record<string, ContextDelta[]>;
  denied: number;
}

export async function runDemo(io: DemoIo, home = mkdtempSync(join(tmpdir(), 'agentree-demo-'))): Promise<DemoResult> {
  const env = { AGENTREE_HOME: home, AGENTREE_USER: 'human-reviewer' };
  const say = (text = '') => io.out(text);
  const step = (n: number, title: string) => say(`\n━━ ${n}. ${title} ${'━'.repeat(Math.max(3, 64 - title.length))}`);
  const $ = (...argv: string[]) => {
    say(`$ agentree ${argv.join(' ')}`);
    const lines: string[] = [];
    const code = run(argv, { out: (t) => lines.push(t), err: (t) => lines.push(t), env, cwd: REPO });
    if (lines.length) say(lines.join('\n'));
    return code;
  };
  const json = <T>(...argv: string[]): T => {
    let text = '';
    run([...argv, '--json'], { out: (t) => { text += t; }, err: () => undefined, env, cwd: REPO });
    return (JSON.parse(text) as { data: T }).data;
  };
  const deliveries: Record<string, ContextDelta[]> = { claude: [], codex: [] };
  const showSync = (agent: DemoAgent) => {
    const delta = agent.sync.sync({ session: agent.session, level: 'digest' });
    deliveries[agent.label].push(delta);
    say(`[${agent.label}] context_sync → ${delta.items.length} item(s), ${delta.stats.filtered} unrelated filtered, ${delta.stats.tokens} tokens`);
    for (const item of delta.items) {
      say(`    ${item.authority.padEnd(19)} ${item.key.padEnd(18)} via ${item.relevance.via}/${item.relevance.match}  "${item.body}"`);
    }
    return delta;
  };

  say(`Agentree two-agent demo · state in ${home} (nothing is written to the project)`);

  step(1, 'Workspace and independent logical branches');
  $('init', 'shop', '--root', `app=${REPO}`);
  $('branch', 'create', 'claude-auth');
  $('branch', 'create', 'codex-api');
  const claudeSession = json<Session>('session', 'register', 'claude-auth', '--agent', 'claude', '--name', 'Claude Code', '--runtime', 'claude', '--native', 'claude-7f3a');
  const codexSession = json<Session>('session', 'register', 'codex-api', '--agent', 'codex', '--name', 'Codex', '--runtime', 'codex', '--native', 'thread-api');
  say('(sessions registered by the human; agents never pick their own identity)');

  const store = new SqliteStore(join(home, 'agentree.sqlite'));
  const claude = await DemoAgent.connect('claude', store, claudeSession);
  const codex = await DemoAgent.connect('codex', store, codexSession);
  try {
    step(2, "Native activity is observed and becomes each agent's focus");
    say(`[claude] ingested ${await claude.observe('claude', claudeRecords)} Claude Code records`);
    say(`[codex]  ingested ${await codex.observe('codex', codexRecords)} Codex App Server notifications`);
    $('log', '--session', claudeSession.nativeId);
    $('log', '--session', codexSession.nativeId);
    $('relevant', 'claude-7f3a');
    $('relevant', 'thread-api');
    say('(observed actions shape relevance only; they grant no permissions)');

    step(3, 'Claude publishes Findings over MCP (unverified, on its own branch)');
    const status = await claude.tool<{ currentSession: { branchId: string } }>('workspace_status', {});
    await claude.tool('context_publish', {
      kind: 'finding', key: 'users-token-check', scope: { type: 'file', path: 'src/api/users.ts' },
      body: 'getUser() calls verifyToken() but ignores the expiry claim; expired tokens are accepted.',
    });
    await claude.tool('context_publish', {
      kind: 'finding', key: 'docs-setup', scope: { type: 'folder', path: 'docs' },
      body: 'docs/setup.md still documents the old AUTH_SECRET variable.',
    });
    say(`[claude] published 2 findings on branch ${status.currentSession.branchId.slice(0, 8)}`);

    step(4, 'Scoped delivery: Codex gets the API finding, the docs finding is filtered');
    showSync(codex);
    step(5, 'Repeated syncs deliver nothing twice (idle polls load no context)');
    showSync(codex);
    showSync(claude);

    step(6, 'Conflicting Decision Proposals');
    const claudeDecision = await claude.tool<{ id: string }>('context_publish', {
      kind: 'decision', key: 'token-ttl', scope: { type: 'folder', path: 'src/auth' },
      body: 'Access tokens expire after 15 minutes; clients must refresh.',
    });
    const mainId = json<{ mainBranchId: string }>('workspace', 'show').mainBranchId;
    const mainRev = () => json<Array<{ id: string; revision: number }>>('branch', 'list').find((b) => b.id === mainId)!.revision;
    const first = await claude.tool<{ id: string; reviewId: string }>('merge_request', { targetBranchId: mainId, commitIds: [claudeDecision.id], expectedRevision: mainRev() });
    say(`[claude] merge_request → review ${first.reviewId.slice(0, 8)} (main always needs a human)`);
    $('review', 'approve', first.reviewId.slice(0, 8));
    showSync(claude);

    const codexDecision = await codex.tool<{ id: string }>('context_publish', {
      kind: 'decision', key: 'token-ttl', scope: { type: 'folder', path: 'src/auth' },
      body: 'Access tokens expire after 60 minutes; mobile API clients cannot refresh mid-request.',
    });
    const second = await codex.tool<{ id: string; reviewId: string }>('merge_request', { targetBranchId: mainId, commitIds: [codexDecision.id], expectedRevision: mainRev() });
    say(`[codex] merge_request → review ${second.reviewId.slice(0, 8)}`);
    showSync(claude);

    step(7, 'Human review — agents cannot decide for themselves');
    const denied = $('--as', 'thread-api', 'review', 'approve', second.reviewId.slice(0, 8));
    $('review', 'list');
    $('review', 'show', second.reviewId.slice(0, 8));
    $('review', 'resolve', second.reviewId.slice(0, 8), '--keep', 'incoming');

    step(8, 'The human decision becomes shared, authoritative context for both');
    showSync(claude);
    showSync(codex);
    for (const agent of [claude, codex]) {
      const items = Object.values(agent.sync.status(agent.session.id).items).filter((r) => r.state === 'delivered').map((r) => r.itemId);
      agent.sync.acknowledge(agent.session.id, items);
    }
    $('context', 'main', '--history');
    $('status');

    step(9, 'Auditable gateway decisions');
    $('log', '--type', 'policy.decision', '--limit', '1000');
    $('log', '--audit', '--type', 'review.decided');

    say('\nDone. Inspect the same state yourself with:');
    say(`  AGENTREE_HOME=${home} npm run agentree -- status`);
    return { home, deliveries, denied };
  } finally {
    await claude.close();
    await codex.close();
    store.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runDemo({ out: (t) => process.stdout.write(`${t}\n`) }, process.env.AGENTREE_HOME).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
