// Real two-agent PendingTree supervision scenario on the running gateway, so every
// step shows up live in the web console:
//   Codex (managed, owns src/api) and Claude Code (owns src/auth) work in one
//   project on separate logical branches. The human writes Main, dispatches tasks
//   to Codex, blocks a dangerous tool call, judges conflicts, accepts work into
//   Main, sends a correction, and stops a session.
//
// Cost guard: Claude runs on the cheapest tier (`haiku` by default) with a small
// --max-turns and only the PendingTree MCP server; Codex refuses to start unless
// CODEX_MODEL names a model explicitly, runs with low reasoning effort and no other
// MCP servers. The project is three tiny files and every prompt forbids exploring.
//
//   CODEX_MODEL=<cheapest codex model> npm run demo:real -- --check   # preflight, no model calls
//   CODEX_MODEL=<cheapest codex model> npm run demo:real              # the real run
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ManagedCodex } from '../packages/adapters/src/codex-managed.js';
import { runManagedClaude } from '../packages/adapters/src/claude-launcher.js';
import { localHumanHeaders } from '../packages/adapters/src/local-auth.js';

const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
const CHECK = has('--check');
const MANUAL = has('--manual'); // also approve PendingTree MCP calls by hand

const dataDir = process.env.PENDINGTREE_HOME || process.env.GATEWAY_DATA_DIR || join(homedir(), '.local', 'share', 'pendingtree');
const gatewayUrl = process.env.HARNESS_GATEWAY_URL || 'http://127.0.0.1:8787';
const database = join(dataDir, 'gateway.sqlite');
const playground = resolve(process.env.PLAYGROUND || join(homedir(), 'pendingtree-two-agents'));
const claudeModel = process.env.CLAUDE_MODEL || 'haiku';
const codexModel = process.env.CODEX_MODEL || '';
const claudeCommand = process.env.CLAUDE_COMMAND || 'claude';
const codexCommand = process.env.CODEX_COMMAND || 'codex';
const HUMAN_WAIT_MS = 10 * 60_000;

const say = (text = '') => process.stdout.write(`${text}\n`);
const step = (n: number | string, title: string) => say(`\n━━ ${n}. ${title}`);
const human = (text: string) => say(`  👤 In the console: ${text}`);
const fail = (message: string): never => { process.stderr.write(`\n✖ ${message}\n`); process.exit(2); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- preflight
function onPath(command: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${JSON.stringify(command)}`], { stdio: 'ignore' }).status === 0;
}

async function preflight(): Promise<void> {
  step(0, 'Preflight (no model calls)');
  const problems: string[] = [];
  if (Number(process.versions.node.split('.')[0]) < 24) problems.push(`Node ${process.versions.node}: use Node 24+.`);
  if (!onPath(claudeCommand)) problems.push(`"${claudeCommand}" not found: install and log in to Claude Code.`);
  if (!onPath(codexCommand)) problems.push(`"${codexCommand}" not found: install and log in to Codex.`);
  if (!codexModel) problems.push('CODEX_MODEL is not set. Set it to the cheapest model your Codex offers (see /model in `codex`). The script never falls back to the default model.');
  try {
    const health = await fetch(`${gatewayUrl}/health`);
    if (!health.ok) problems.push(`Gateway at ${gatewayUrl} answered ${health.status}.`);
  } catch { problems.push(`Gateway not reachable at ${gatewayUrl}: run npm start in another terminal.`); }
  say(`  gateway   ${gatewayUrl}  (data ${dataDir})`);
  say(`  project   ${playground}`);
  say(`  models    Claude: ${claudeModel} (max 12 turns) · Codex: ${codexModel || '(not set)'} (reasoning effort low)`);
  say(`  approvals ${MANUAL ? 'all by hand in the console' : 'PendingTree MCP calls auto-approved by this script; every other tool call by hand'}`);
  if (problems.length) fail(`Not ready:\n  - ${problems.join('\n  - ')}`);
  say('  ✔ ready');
}

// ---------------------------------------------------------------- project
/** A tiny project so the agents read little: auth (Claude) and api (Codex). */
function seedPlayground(): void {
  const files: Record<string, string> = {
    'README.md': '# Demo shop\n\nsrc/auth: token handling (Claude). src/api: HTTP handlers (Codex).\n',
    'src/auth/token.ts': 'export const TOKEN_TTL_MINUTES = 15;\n\n// Checks the signature only; the expiry claim is not checked yet.\nexport function verifyToken(token: string): boolean {\n  return token.startsWith("signed:");\n}\n',
    'src/api/users.ts': 'import { verifyToken } from "../auth/token";\n\nexport function getUser(req: { token: string; id: string }) {\n  if (!verifyToken(req.token)) throw new Error("unauthorized");\n  return { id: req.id };\n}\n',
  };
  for (const [path, text] of Object.entries(files)) {
    const full = join(playground, path);
    mkdirSync(join(full, '..'), { recursive: true });
    if (!existsSync(full)) writeFileSync(full, text);
  }
  if (!existsSync(join(playground, '.git'))) spawnSync('git', ['init', '-q'], { cwd: playground });
}

// ---------------------------------------------------------------- gateway (as the human)
const api = async <T>(path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${gatewayUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...localHumanHeaders(gatewayUrl,database), 'content-type': 'application/json' },
    redirect: 'error',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${body === undefined ? 'GET' : 'POST'} ${path} → ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
};
type Approval = { id: string; state: string; tool: string; input: unknown };
type Task = { id: string; status: string; nativeTurnId?: string; reason?: string };
type Overview = { work: Array<{ id: string; sessionId: string; state: string; body: string }>; corrections: unknown[] };

/** Approves only PendingTree MCP calls and Claude's ToolSearch (collaboration plumbing); everything else waits for the human. */
function startApprovalHelper(): () => void {
  const told = new Set<string>();
  const timer = setInterval(() => { void (async () => {
    for (const a of (await api<Approval[]>('/v1/approvals')).filter((x) => x.state === 'pending')) {
      // ToolSearch is how Claude Code loads the deferred PendingTree MCP tools: plumbing too.
      if (!MANUAL && (a.tool.startsWith('mcp__pendingtree__') || a.tool === 'ToolSearch')) {
        await api(`/v1/approvals/${a.id}`, { decision: 'approved', reason: 'demo helper: PendingTree MCP call' }).catch(() => undefined);
      } else if (!told.has(a.id)) {
        told.add(a.id);
        human(`Approvals → allow or deny within 60 s: ${a.tool} ${JSON.stringify(a.input).slice(0, 90)}`);
      }
    }
  })().catch(() => undefined); }, 300);
  return () => clearInterval(timer);
}

type SessionView = { state: string; taskDispatch?: { available?: boolean } };
/**
 * The Gateway records a task as not deliverable at submission unless the managed
 * runner polled within the last few seconds, and never retries it. ManagedCodex.open
 * returns before the runner's first poll (it first replays startup events), so wait
 * until the Gateway itself reports the runner as available.
 */
async function waitForRunner(sessionId: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const session = await api<SessionView>(`/v1/sessions/${sessionId}`).catch(() => undefined);
    if (session?.taskDispatch?.available) return true;
    if (session && session.state !== 'active') return false;
    await sleep(500);
  }
  return false;
}

/** Dispatch a task through the same route as the console's Tasks page, then follow its status. */
async function dispatch(sessionId: string, instructions: string): Promise<Task> {
  if (!await waitForRunner(sessionId, 30_000)) say('  ⚠ the Codex runner is not polling the Gateway; this task will be recorded as not deliverable.');
  const created = await api<Task>('/v1/tasks', { sessionId, instructions, includeMain: true, requestId: randomUUID() });
  say(`  task ${created.id.slice(0, 8)} submitted (POST /v1/tasks, Main attached) · ${created.status}`);
  let last = created.status;
  const end = Date.now() + 6 * 60_000;
  for (;;) {
    const task = await api<Task>(`/v1/tasks/${created.id}`);
    if (task.status !== last) { say(`  task → ${task.status}${task.nativeTurnId ? ` (native turn ${task.nativeTurnId.slice(0, 8)})` : ''}${task.reason ? ` · ${task.reason}` : ''}`); last = task.status; }
    if (['completed', 'failed', 'cancelled', 'delivery-unavailable', 'outcome-unknown'].includes(task.status)) return task;
    if (Date.now() > end) { say('  task still running after 6 minutes; continuing (see the Tasks page).'); return task; }
    await sleep(1000);
  }
}

async function waitForHuman<T>(what: string, check: () => Promise<T | undefined | false>): Promise<T | undefined> {
  human(what);
  const end = Date.now() + HUMAN_WAIT_MS;
  while (Date.now() < end) {
    const value = await check().catch(() => undefined);
    if (value) { say('  ✔ done'); return value; }
    await sleep(1500);
  }
  say('  (no human action within 10 minutes; continuing)');
  return undefined;
}

// ---------------------------------------------------------------- scenario
const RULES = 'Keep it minimal: use as few tool calls and words as possible, do not explore other files.';
await preflight();
seedPlayground();
if (CHECK) { say('\n--check: project seeded, nothing sent to any model. Run again without --check for the real run.'); process.exit(0); }

say('\nKeep the console open on http://localhost:5173 (Tasks, Approvals, Conflicts, Branches, Main).');
const stopHelper = startApprovalHelper();
let codex: ManagedCodex | undefined;
try {
  step(1, 'Codex joins as a managed session (branch "Codex", owns src/api)');
  codex = await ManagedCodex.open({
    gatewayUrl, databasePath: database, cwd: playground, label: 'Codex',
    adapter: {
      command: codexCommand,
      args: ['app-server', '--listen', 'stdio://', '-c', `model=${JSON.stringify(codexModel)}`, '-c', 'model_reasoning_effort="low"', '-c', 'mcp_servers={}'],
    },
  });
  const codexSession = codex.gateway.session;
  const workspace = await api<{ id: string; roots: Array<{ id: string }> }>(`/v1/workspaces/${codexSession.workspaceId}`);
  const root = workspace.roots[0]?.id ?? 'root';
  const file = (path: string) => ({ rootId: root, path });
  say(`  session ${codexSession.id.slice(0, 8)} · model ${codexModel} · waiting for its task runner to connect…`);
  if (!await waitForRunner(codexSession.id, 120_000)) throw new Error('The Codex task runner did not connect to the Gateway within 2 minutes; nothing was dispatched. Check that Codex is logged in, then run the demo again.');
  say('  runner polling for tasks');

  step(2, 'The human writes Main: the shared expectations both agents receive');
  const before = await api<{ revision: number }>(`/v1/workspaces/${workspace.id}/main`);
  await api(`/v1/workspaces/${workspace.id}/main`, { body: 'Access tokens expire after 15 minutes; verifyToken must reject expired tokens.', files: [file('src/auth/token.ts')], expectedRevision: before.revision });
  await api(`/v1/workspaces/${workspace.id}/main`, { body: 'getUser must return 401-style errors as { error: { code, message } }.', files: [file('src/api/users.ts')], expectedRevision: before.revision + 1 });
  say('  2 Main entries recorded (see the Main page and its history).');

  step(3, 'The human dispatches a task to Codex; delivery follows native evidence');
  await dispatch(codexSession.id, `You own src/api. Edit src/api/users.ts so getUser returns { error: { code: "unauthorized", message } } instead of throwing. Then call the pendingtree tool work_propose with a one-sentence body and files [{"rootId":"${root}","path":"src/api/users.ts"},{"rootId":"${root}","path":"src/auth/token.ts"}] (you rely on verifyToken). Reply DONE. ${RULES}`);

  step(4, 'Claude Code joins (branch "Claude", owns src/auth), reads Main, works, and tries a forbidden push');
  say('  Every Claude tool call waits for the console; PendingTree MCP calls are auto-approved by this script.');
  const code = await runManagedClaude({
    cwd: playground, label: 'Claude', gatewayUrl, databasePath: database, command: claudeCommand,
    args: ['-p', `You own src/auth. 1) Call the pendingtree tool context_get and read Main and any corrections. 2) Edit src/auth/token.ts so verifyToken also rejects expired tokens, following Main. 3) Call the pendingtree tool work_propose with a one-sentence body and files [{"rootId":"${root}","path":"src/auth/token.ts"}]. 4) Run the Bash command: git push --force . Reply DONE. ${RULES}`,
      '--model', claudeModel, '--max-turns', '12', '--strict-mcp-config'],
  });
  if (code !== 0) say(`  (Claude exited with ${code})`);
  const claudeSession = (await api<Array<{ id: string; runtime: string; branchId: string; workspaceId: string }>>('/v1/sessions'))
    .filter((s) => s.runtime === 'claude-code' && s.workspaceId === workspace.id).at(-1);

  step(5, 'Human supervision: conflicts, accepting work into Main, and a correction');
  const conflicts = await api<Array<{ status: string; files: Array<{ path: string }> }>>(`/v1/workspaces/${workspace.id}/conflicts`);
  say(`  ${conflicts.filter((c) => c.status === 'potential').length} potential conflict(s) from file evidence, e.g. ${conflicts.map((c) => c.files.map((f) => f.path).join(',')).filter(Boolean).slice(0, 2).join(' / ') || '—'}`);
  if (conflicts.some((c) => c.status === 'potential')) {
    await waitForHuman('Conflicts → confirm or dismiss each potential conflict with an explanation.', async () => {
      const now = await api<Array<{ status: string }>>(`/v1/workspaces/${workspace.id}/conflicts`);
      return now.every((c) => c.status !== 'potential');
    });
  }
  if (claudeSession) {
    await waitForHuman('Branches → open "Claude" and accept its proposed work into Main.', async () => {
      const overview = await api<Overview>(`/v1/branches/${claudeSession.branchId}/work`);
      return overview.work.some((w) => w.state === 'accepted');
    });
  }
  await waitForHuman('Branches → open "Codex" and send a correction, e.g. "Do not change verifyToken; Claude owns src/auth."', async () => {
    const overview = await api<Overview>(`/v1/branches/${codexSession.branchId}/work`);
    return overview.corrections.length > 0;
  });

  step(6, 'Follow-up task: Codex retrieves the correction and the updated Main');
  const followUp = await dispatch(codexSession.id, 'Call the pendingtree tool context_sync with requestId "codex-final", then context_acknowledge with the item ids you received. Reply with one sentence: the correction you received and the current token expiry rule in Main. Do not edit files. ' + RULES);
  say(`  follow-up task ${followUp.status}; its native evidence is on the Tasks page.`);

  step(7, 'Stop the run');
  await waitForHuman('Overview → press Stop on the Codex session.', async () => {
    const s = await api<{ state: string }>(`/v1/sessions/${codexSession.id}`);
    return s.state !== 'active' && s.state;
  });
  say('\nDone. Review Main history (/main/history), Tasks, and: npm run pendingtree -- log --audit');
} finally {
  stopHelper();
  await codex?.close().catch(() => undefined);
}
