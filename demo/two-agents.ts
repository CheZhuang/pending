// Deterministic two-session supervision scenario. Native observations are
// replayed through adapters; all governance decisions are explicit human calls.
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
import { EntityLedger, type ContextDelta } from '../packages/sync/src/index.js';
import { run } from '../apps/cli/src/cli.js';
import { Home } from '../apps/cli/src/home.js';

export interface DemoIo { out(text: string): void; }
const REPO = '/demo/repo';
const at = (s: number) => new Date(Date.UTC(2026, 10, 7, 10, 0, s)).toISOString();
const claudeRecords: NativeRecord[] = [
  { nativeId: 'c-msg-1', type: 'user.message', occurredAt: at(1), payload: { text: 'Harden session token handling in src/auth' } },
  { nativeId: 'c-call-1', type: 'tool.call', occurredAt: at(2), payload: { tool: 'Edit', input: { file_path: `${REPO}/src/api/users.ts` } } },
];
const codexRecords: NativeRecord[] = [
  { nativeId: 'x-item-1', type: 'item/completed', occurredAt: at(3), payload: { method: 'item/completed', params: { item: { type: 'fileChange', changes: [{ path: `${REPO}/src/api/users.ts`, kind: 'update' }] } } } },
];

class DemoAgent {
  private constructor(readonly label: string, readonly session: Session, readonly service: AgentreeService, private readonly mcp: Client) {}
  static async connect(label: string, store: SqliteStore, session: Session) {
    const service = new AgentreeService(store, { type: 'agent', sessionId: session.id }); const ledger = new EntityLedger(store);
    const server = createAgentreeMcpServer({ session, service, ledger }); const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: label, version: '0.2.0' }); await server.connect(serverSide); await mcp.connect(clientSide);
    return new DemoAgent(label, session, service, mcp);
  }
  async tool<T = Record<string, unknown>>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await this.mcp.callTool({ name, arguments: args }); const out = result.structuredContent as { ok: boolean; data?: T; error?: { code: string; message: string } };
    if (!out.ok) throw new Error(`${name}: ${out.error?.code} ${out.error?.message}`); return out.data as T;
  }
  async observe(runtime: string, records: NativeRecord[]) {
    const native = { runtime, nativeId: this.session.nativeId, cwd: REPO }; const adapter = new MockAgentAdapter(runtime, [native], new Map([[native.nativeId, records]]));
    const binding = { ...native, sessionId: this.session.id, workspaceId: this.session.workspaceId, branchId: this.session.branchId }; const cursors = new MemoryCursorStore(); let count = 0;
    for (;;) { const batch = await ingestNextBatch(adapter, binding, cursors, { ingest: (e) => this.service.ingest(e) }); count += batch.records.length; if (!batch.hasMore) return count; }
  }
  close() { return this.mcp.close(); }
}
export interface DemoResult { home: string; deliveries: Record<string, ContextDelta[]>; denied: number; }

export async function runDemo(io: DemoIo, home = mkdtempSync(join(tmpdir(), 'agentree-demo-'))): Promise<DemoResult> {
  const env = { AGENTREE_HOME: home, AGENTREE_USER: 'human-reviewer' }; const say = (s = '') => io.out(s);
  const step = (n: number, title: string) => say(`\n━━ ${n}. ${title} ${'━'.repeat(Math.max(3, 64 - title.length))}`);
  const $ = (...args: string[]) => { say(`$ agentree ${args.join(' ')}`); const lines: string[] = []; const code = run(args, { out: (t) => lines.push(t), err: (t) => lines.push(t), env, cwd: REPO }); if (lines.length) say(lines.join('\n')); return code; };
  const json = <T>(...args: string[]): T => { let out = ''; run([...args, '--json'], { out: (t) => out += t, err: () => undefined, env, cwd: REPO }); return (JSON.parse(out) as { data: T }).data; };
  const deliveries: Record<string, ContextDelta[]> = { claude: [], codex: [] };
  const homeStore = () => new Home(home).dbPath;
  say(`Agentree supervision scenario · isolated state at ${home}`);
  step(1, 'Register two independent native sessions'); $('init', 'shop', '--root', `app=${REPO}`); $('branch', 'create', 'claude-auth'); $('branch', 'create', 'codex-api');
  const claudeSession = json<Session>('session', 'register', 'claude-auth', '--agent', 'claude', '--name', 'Claude Code', '--runtime', 'claude', '--native', 'claude-7f3a');
  const codexSession = json<Session>('session', 'register', 'codex-api', '--agent', 'codex', '--name', 'Codex', '--runtime', 'codex', '--native', 'thread-api');
  const store = new SqliteStore(homeStore()); const claude = await DemoAgent.connect('claude', store, claudeSession); const codex = await DemoAgent.connect('codex', store, codexSession);
  try {
    step(2, 'Record Main guidance and observe native file activity'); $('main', 'add', 'API responses preserve the request ID header.', '--file', 'app=src/api/users.ts');
    say(`[claude] observed ${await claude.observe('claude', claudeRecords)} native records`); say(`[codex] observed ${await codex.observe('codex', codexRecords)} native records`);
    $('log', '--session', claudeSession.nativeId); $('log', '--session', codexSession.nativeId);

    step(3, 'Agents retrieve Main and propose branch work through MCP');
    const initialC = await claude.tool<ContextDelta>('context_sync', { requestId: 'initial-c' }); const initialX = await codex.tool<ContextDelta>('context_sync', { requestId: 'initial-x' });
    deliveries.claude.push(initialC); deliveries.codex.push(initialX);
    say(`[claude] retrieved ${initialC.items.length} item(s); [codex] retrieved ${initialX.items.length} item(s)`);
    const mainEntry = json<{ entries: Array<{ id: string }> }>('main').entries[0]!;
    const cwork = await claude.tool<{ id: string }>('work_propose', { body: 'Preserved the request ID header while updating token handling.', files: [{ rootId: 'app', path: 'src/api/users.ts' }], intent: 'Keep API identity traceable.' });
    const xwork = await codex.tool<{ id: string }>('work_propose', { body: 'Added request ID propagation to API errors; this may violate the recorded header expectation.', files: [{ rootId: 'app', path: 'src/api/users.ts' }], conflictsWithMain: [mainEntry.id] });
    $('branch', 'show', 'claude-auth'); $('branch', 'show', 'codex-api');

    step(4, 'Human reviews work, records a potential overlap, and sends a correction');
    $('conflict', 'list'); const conflict = json<Array<{ id: string; status: string; mainEntryId?: string; evidenceIds: string[] }>>('conflict', 'list').find(c => c.status === 'potential' && c.mainEntryId === mainEntry.id && c.evidenceIds.includes(xwork.id));
    if (conflict) $('conflict', 'decide', conflict.id, 'confirmed', 'The proposal explicitly flags incompatibility with the active Main header requirement.');
    $('correction', 'send', 'codex-api', 'Keep the existing response header name exactly as recorded in Main.');
    const updateC = await claude.tool<ContextDelta>('context_sync', { requestId: 'update-c' }); const updateX = await codex.tool<ContextDelta>('context_sync', { requestId: 'update-x' });
    deliveries.claude.push(updateC); deliveries.codex.push(updateX);
    say(`[codex] correction retrieval: ${updateX.items.filter(i => i.kind === 'correction').length} correction(s)`);

    step(5, 'Human accepts one work record into Main; the new snapshot reaches both sessions');
    $('work', 'accept', 'claude-auth', cwork.id); const acceptedC = await claude.tool<ContextDelta>('context_sync', { requestId: 'accepted-c' }); const acceptedX = await codex.tool<ContextDelta>('context_sync', { requestId: 'accepted-x' });
    deliveries.claude.push(acceptedC); deliveries.codex.push(acceptedX); $('main'); $('merge');
    const denied = $('--as', codexSession.id, 'main', 'add', 'agent must not edit Main', '--json');
    say(`Agent Main edit exit code: ${denied}`);
    await claude.close(); await codex.close(); store.close();
    return { home, deliveries, denied };
  } catch (error) { await claude.close(); await codex.close(); store.close(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDemo({ out: (line) => process.stdout.write(`${line}\n`) }).catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
}
