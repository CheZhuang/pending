// Real two-agent Agentree scenario: Codex (src/api) and Claude Code (src/auth)
// work in one project on separate logical branches, share a scoped finding,
// propose conflicting decisions, and a human resolves the conflict in the web
// console; then both agents sync the accepted decision. Uses the running
// gateway (npm start) so everything shows up live in the console.
//
// Cost guard: Claude runs on the cheapest tier (`haiku` by default) with a
// small --max-turns, and Codex refuses to start unless CODEX_MODEL names a model
// explicitly, with low reasoning effort. Only the Agentree MCP server is loaded.
//
//   CODEX_MODEL=<cheapest codex model> npm run demo:real -- --check   # preflight, no tokens
//   CODEX_MODEL=<cheapest codex model> npm run demo:real              # the real run
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ManagedCodex } from '../packages/adapters/src/codex-managed.js';
import { runManagedClaude } from '../packages/adapters/src/claude-launcher.js';

const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
const CHECK = has('--check');
const MANUAL = has('--manual'); // also approve Agentree MCP calls by hand

const dataDir = process.env.GATEWAY_DATA_DIR || join(homedir(), '.local', 'share', 'agentree');
const gatewayUrl = process.env.HARNESS_GATEWAY_URL || 'http://127.0.0.1:8787';
const database = join(dataDir, 'gateway.sqlite');
const playground = resolve(process.env.PLAYGROUND || join(homedir(), 'agentree-two-agents'));
const claudeModel = process.env.CLAUDE_MODEL || 'haiku';
const codexModel = process.env.CODEX_MODEL || '';
const claudeCommand = process.env.CLAUDE_COMMAND || 'claude';
const codexCommand = process.env.CODEX_COMMAND || 'codex';

const say = (text = '') => process.stdout.write(`${text}\n`);
const step = (n: number | string, title: string) => say(`\n━━ ${n}. ${title}`);
const fail = (message: string): never => { process.stderr.write(`\n✖ ${message}\n`); process.exit(2); };

// ---------------------------------------------------------------- preflight
function onPath(command: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${JSON.stringify(command)}`], { stdio: 'ignore' }).status === 0;
}

async function preflight(): Promise<{ token: string }> {
  step(0, 'Preflight (no model calls)');
  const problems: string[] = [];
  if (Number(process.versions.node.split('.')[0]) < 24) problems.push(`Node ${process.versions.node}: use Node 24+.`);
  if (!onPath(claudeCommand)) problems.push(`"${claudeCommand}" not found: install and log in to Claude Code.`);
  if (!onPath(codexCommand)) problems.push(`"${codexCommand}" not found: install and log in to Codex.`);
  if (!codexModel) problems.push('CODEX_MODEL is not set. Set it to the cheapest model your Codex offers (see the model picker in `codex`). The script never falls back to the default model.');
  let token = process.env.HARNESS_ADMIN_TOKEN ?? '';
  if (!token) {
    try { token = readFileSync(join(dataDir, 'admin-token'), 'utf8').trim(); } catch { problems.push(`No admin token in ${dataDir}: start the gateway first (npm start).`); }
  }
  try {
    const health = await fetch(`${gatewayUrl}/health`);
    if (!health.ok) problems.push(`Gateway at ${gatewayUrl} answered ${health.status}.`);
  } catch { problems.push(`Gateway not reachable at ${gatewayUrl}: run npm start in another terminal.`); }
  say(`  gateway   ${gatewayUrl}  (data ${dataDir})`);
  say(`  project   ${playground}`);
  say(`  models    Claude: ${claudeModel} (max 10 turns) · Codex: ${codexModel || '(not set)'} (reasoning effort low)`);
  say(`  approvals ${MANUAL ? 'all by hand in the console' : 'Agentree MCP calls auto-approved by this script; everything else by hand'}`);
  if (problems.length) fail(`Not ready:\n  - ${problems.join('\n  - ')}`);
  say('  ✔ ready');
  return { token };
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

// ---------------------------------------------------------------- gateway helpers
let admin = '';
const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(`${gatewayUrl}${path}`, { ...init, headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' } });
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
};
type Approval = { id: string; state: string; tool: string; sessionId: string; input: unknown };
type Review = { id: string; state: string; mergeId: string; conflicts: unknown[] };

/** Approves only Agentree MCP calls (collaboration plumbing); everything else waits for the human. */
function startApprovalHelper(): () => void {
  const told = new Set<string>();
  const timer = setInterval(() => { void (async () => {
    for (const a of (await api<Approval[]>('/v1/approvals')).filter((x) => x.state === 'pending')) {
      if (!MANUAL && a.tool.startsWith('mcp__agentree__')) {
        await api(`/v1/approvals/${a.id}`, { method: 'POST', body: JSON.stringify({ decision: 'approved', reason: 'demo helper: Agentree MCP call' }) }).catch(() => undefined);
      } else if (!told.has(a.id)) {
        told.add(a.id);
        say(`  ⏳ waiting for YOU in the console (Reviews → Tool approvals, 60 s): ${a.tool} ${JSON.stringify(a.input).slice(0, 90)}`);
      }
    }
  })().catch(() => undefined); }, 300);
  return () => clearInterval(timer);
}

async function waitForHumanReview(timeoutMs = 10 * 60_000): Promise<void> {
  say('  ⏳ Open the console → Reviews → resolve the token-ttl conflict (pick a side, Resolve & apply).');
  const end = Date.now() + timeoutMs;
  let seen = false;
  while (Date.now() < end) {
    const pending = (await api<Review[]>('/v1/reviews')).filter((r) => r.state === 'pending' && r.conflicts.length);
    if (pending.length) seen = true;
    else if (seen) { say('  ✔ conflict resolved by a human'); return; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail('No human decision within 10 minutes.');
}

// ---------------------------------------------------------------- agents
const RULES = 'Use as few tool calls and words as possible. Do not explore other files. Do not edit files.';

async function runClaude(prompt: string, branchId?: string): Promise<void> {
  const code = await runManagedClaude({
    cwd: playground, label: 'Claude', gatewayUrl, databasePath: database, command: claudeCommand,
    ...(branchId ? { branchId } : {}),
    args: ['-p', `${prompt} ${RULES}`, '--model', claudeModel, '--max-turns', '10', '--strict-mcp-config'],
  });
  if (code !== 0) say(`  (Claude exited with ${code})`);
}

async function codexTurn(codex: ManagedCodex, prompt: string): Promise<void> {
  const started = await codex.startTurn(`${prompt} ${RULES}`);
  const turn = await codex.waitForTurn(started.turn.id, 5 * 60_000);
  say(`  Codex turn ${turn.status}`);
}

async function claudeBranch(): Promise<string | undefined> {
  const sessions = await api<Array<{ runtime: string; branchId: string }>>('/v1/sessions');
  return sessions.filter((s) => s.runtime === 'claude-code').at(-1)?.branchId;
}

// ---------------------------------------------------------------- scenario
const { token } = await preflight();
admin = token;
seedPlayground();
if (CHECK) { say('\n--check: project seeded, nothing sent to any model. Run again without --check for the real run.'); process.exit(0); }

say('\nKeep the console open on http://localhost:5173 (Reviews and Context pages).');
const stopHelper = startApprovalHelper();
let codex: ManagedCodex | undefined;
try {
  step(1, 'Codex joins (branch "Codex", works on src/api)');
  codex = await ManagedCodex.open({
    gatewayUrl, databasePath: database, cwd: playground, label: 'Codex', adminToken: admin,
    adapter: {
      command: codexCommand,
      args: ['app-server', '--listen', 'stdio://', '-c', `model=${JSON.stringify(codexModel)}`, '-c', 'model_reasoning_effort="low"', '-c', 'mcp_servers={}'],
      threadStartParams: { approvalPolicy: 'untrusted', sandbox: 'read-only' },
    },
  });
  say(`  session ${codex.gateway.session.id.slice(0, 8)} · model ${codexModel}`);

  step(2, 'Codex publishes a scoped Finding over MCP');
  await codexTurn(codex, 'You own src/api. Call the agentree tool context_subscribe with scopes [{"type":"folder","path":"src/api"}]. Read src/api/users.ts. Then call context_publish with kind "finding", key "users-token-expiry", scope {"type":"file","path":"src/api/users.ts"}, impactScope {"type":"folder","path":"src/auth"}, and a one-sentence body saying getUser trusts verifyToken, which does not reject expired tokens. Reply DONE.');

  step(3, 'Claude joins (branch "Claude", works on src/auth), receives the Finding, proposes a Decision');
  say('  Claude asks before every tool; Agentree MCP calls are approved by this script, Bash waits for you.');
  await runClaude('You own src/auth. 1) Call the agentree tool context_subscribe with scopes [{"type":"folder","path":"src/auth"}]. 2) Call context_sync with requestId "claude-sync-1" and level "digest" and read the findings. 3) Call context_publish with kind "decision", key "token-ttl", scope {"type":"folder","path":"src/auth"}, body "Access tokens expire after 15 minutes; clients must refresh." 4) Call workspace_status, then merge_request with targetBranchId = the main branch id, commitIds = [your decision commit id], expectedRevision = the main branch revision. 5) Run the Bash command: git push --force . Reply DONE.');

  step(4, 'Codex proposes a conflicting Decision');
  await codexTurn(codex, 'Call context_publish with kind "decision", key "token-ttl", scope {"type":"folder","path":"src/auth"}, body "Access tokens expire after 60 minutes; mobile API clients cannot refresh mid-request." Then call workspace_status and merge_request with targetBranchId = the main branch id, commitIds = [that commit id], expectedRevision = the main branch revision. Reply DONE.');

  step(5, 'Human review in the console');
  await waitForHumanReview();

  step(6, 'Both agents sync the accepted shared decision');
  await codexTurn(codex, 'Call context_sync with requestId "codex-sync-final" and level "signal". Then call context_acknowledge with the item ids you received. Reply with one sentence: which token-ttl decision is now accepted.');
  await runClaude('Call the agentree tool context_sync with requestId "claude-sync-final" and level "signal", then context_acknowledge with the item ids. Reply with one sentence: which token-ttl decision is now accepted.', await claudeBranch());

  step(7, 'Stop (terminate the run)');
  say('  Press Stop on the Codex session in the console Overview within 2 minutes (or wait to end normally).');
  const end = Date.now() + 120_000;
  while (Date.now() < end) {
    const s = await api<{ state: string }>(`/v1/sessions/${codex.gateway.session.id}`);
    if (s.state !== 'active') { say(`  ✔ Codex session ${s.state}`); break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  say('\nDone. See the Context page (branch tree) and: npm run agentree -- log --audit');
} finally {
  stopHelper();
  await codex?.close().catch(() => undefined);
}
