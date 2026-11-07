// CLI behavior on a real SQLite file shared with simulated agents: setup,
// review inspection, approve/resolve, preview without delivery, scriptable
// JSON, and how authorization / stale / usage errors are presented.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Knowledge } from '../../../packages/contracts/src/index.js';
import { AgentreeService } from '../../../packages/core/src/index.js';
import { SqliteStore } from '../../../packages/storage/src/index.js';
import { run } from './cli.js';
import { agentreeHome, DB_FILE, Home } from './home.js';

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'agentree-cli-'));
  const cli = (...argv: string[]) => {
    const out: string[] = [], err: string[] = [];
    const code = run(argv, { out: (t) => out.push(t), err: (t) => err.push(t), env: { AGENTREE_HOME: home, AGENTREE_USER: 'reviewer' }, cwd: '/repo' });
    return { code, out: out.join('\n'), err: err.join('\n'), json: () => JSON.parse(out.join('\n')) };
  };
  return { home, cli, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** Workspace with alice/bob agent branches, registered through the CLI. */
function demo() {
  const s = setup();
  const ws = s.cli('init', 'demo', '--root', 'app=/repo', '--json').json().data;
  s.cli('branch', 'create', 'alice');
  s.cli('branch', 'create', 'bob');
  const alice = s.cli('session', 'register', 'alice', '--agent', 'claude-1', '--runtime', 'claude', '--native', 'c-1', '--json').json().data;
  const bob = s.cli('session', 'register', 'bob', '--agent', 'codex-1', '--runtime', 'codex', '--native', 'x-1', '--json').json().data;
  // Agents act through their own authorized services on the same SQLite file.
  const store = new SqliteStore(new Home(s.home).dbPath);
  const aliceAgent = new AgentreeService(store, { type: 'agent', sessionId: alice.id });
  const bobAgent = new AgentreeService(store, { type: 'agent', sessionId: bob.id });
  aliceAgent.ingest({ id: 'e1', workspaceId: ws.id, source: 'claude:c-1', nativeId: '1', sessionId: alice.id, type: 'tool.use', mode: 'observed',
    payload: { tool_name: 'Edit', tool_input: { file_path: '/repo/src/auth/token.ts' } }, occurredAt: new Date().toISOString() });
  return { ...s, ws, alice, bob, store, aliceAgent, bobAgent, done: () => { store.close(); s.cleanup(); } };
}

const decision = (key: string, body: string, scope: Knowledge['scope'], impactScope?: Knowledge['scope']): Knowledge =>
  ({ kind: 'decision', key, body, scope, ...(impactScope ? { impactScope } : {}) });

test('help, unknown commands and bad flags are usage errors', () => {
  const s = setup();
  try {
    assert.equal(s.cli().code, 0);
    assert.match(s.cli('--help').out, /review resolve/);
    const unknown = s.cli('bogus');
    assert.equal(unknown.code, 2);
    assert.match(unknown.err, /error \[USAGE\]: Unknown command "bogus"/);
    assert.equal(s.cli('status', '--nope').code, 2);
    const none = s.cli('status');
    assert.equal(none.code, 2);
    assert.match(none.err, /agentree init/);
  } finally { s.cleanup(); }
});

test('workspace selection: init selects, use switches, ids and names resolve by prefix', () => {
  const s = setup();
  try {
    const one = s.cli('init', 'one', '--json').json().data;
    const two = s.cli('init', 'two', '--root', '/srv/api', '--json').json().data;
    assert.deepEqual(two.roots, [{ id: 'api', path: '/srv/api' }]);
    assert.equal(s.cli('workspace', 'show', '--json').json().data.id, two.id);
    assert.equal(s.cli('workspace', 'use', one.id.slice(0, 6)).code, 0);
    assert.equal(s.cli('workspace', 'show', '--json').json().data.name, 'one');
    assert.equal(s.cli('status', '-w', 'two', '--json').json().data.workspace.id, two.id);
    assert.match(s.cli('workspace', 'list').out, /\* +one/);
  } finally { s.cleanup(); }
});

test('full human review flow: inspect, refuse agent approval, resolve conflict, audit trail', () => {
  const d = demo();
  try {
    // Alice's decision goes to main through a reviewed merge.
    const d1 = d.aliceAgent.publish(d.alice.branchId, decision('token-ttl', 'TTL is 15 minutes', { type: 'folder', path: 'src/auth' }, { type: 'folder', path: 'src/api' }));
    const m1 = d.cli('merge', 'create', 'alice', 'main', d1.id.slice(0, 8), '--json').json().data;
    assert.ok(m1.reviewId, 'main always needs review');
    const approved = d.cli('review', 'approve', m1.reviewId.slice(0, 8));
    assert.equal(approved.code, 0, approved.err);
    assert.match(approved.out, /approved by reviewer; merge .* applied/);

    // Bob proposes a conflicting decision.
    const d2 = d.bobAgent.publish(d.bob.branchId, decision('token-ttl', 'TTL is 60 minutes for API clients', { type: 'folder', path: 'src/api' }));
    const m2 = d.cli('merge', 'create', 'bob', 'main', d2.id, '--json').json().data;
    assert.equal(d.cli('review', 'list', '--json').json().data.length, 1);

    const shown = d.cli('review', 'show', m2.reviewId.slice(0, 8));
    assert.equal(shown.code, 0);
    assert.match(shown.out, /Conflicts/);
    assert.match(shown.out, /existing .*TTL is 15 minutes/);
    assert.match(shown.out, /incoming .*TTL is 60 minutes/);
    assert.match(shown.out, /review resolve/);

    // An agent cannot approve its own merge: refused by the gateway, exit 3, and audited.
    const sneaky = d.cli('--as', 'x-1', 'review', 'approve', m2.reviewId, '--json');
    assert.equal(sneaky.code, 3);
    assert.equal(sneaky.json().error.code, 'DENY');
    assert.match(sneaky.json().error.hint, /recorded/);
    const audit = d.cli('log', '--type', 'policy.decision', '--limit', '1000').out;
    assert.match(audit, /agent:[0-9a-f]{8} review\.resolve → DENY/);

    // Resolving needs a choice per conflict; bad picks are usage errors.
    assert.equal(d.cli('review', 'resolve', m2.reviewId).code, 5);
    assert.equal(d.cli('review', 'resolve', m2.reviewId, '--pick', '9=incoming').code, 2);
    assert.equal(d.cli('review', 'resolve', m2.reviewId, '--keep', 'both').code, 2);
    const resolved = d.cli('review', 'resolve', m2.reviewId, '--pick', '1=incoming', '--json').json().data;
    assert.equal(resolved.review.decision, 'approved');
    assert.deepEqual(resolved.review.resolutions.map((r: { selectedCommitId: string }) => r.selectedCommitId), [d2.id]);
    assert.equal(resolved.merge.state, 'applied');
    assert.equal(d.cli('review', 'list').out.trim(), '(none)');
    // Applying the merge moves the review to its final "resolved" state.
    assert.match(d.cli('review', 'list', '--all').out, /resolved .*bob → main +1 +reviewer/);

    // The human decision is now the shared context; history keeps the old one as superseded.
    const main = d.cli('context', 'main').out;
    assert.match(main, /accepted-decision .*TTL is 60 minutes/);
    assert.doesNotMatch(main, /TTL is 15 minutes/);
    assert.match(d.cli('context', 'main', '--history').out, /superseded-decision .*TTL is 15 minutes/);

    // Full collaboration + audit sequence is readable from the CLI.
    const log = d.cli('log', '--audit', '--limit', '1000').out;
    for (const pattern of [/context\.published/, /merge\.created/, /review\.decided .*approved by human:reviewer \(1 conflict choice/, /merge\.applied/]) assert.match(log, pattern);
  } finally { d.done(); }
});

test('relevant previews delivery without marking anything delivered', () => {
  const d = demo();
  try {
    d.bobAgent.publish(d.bob.branchId, { kind: 'finding', key: 'auth-bug', body: 'refresh token not rotated', scope: { type: 'file', path: 'src/auth/token.ts' } });
    d.bobAgent.publish(d.bob.branchId, { kind: 'finding', key: 'css', body: 'button colours', scope: { type: 'folder', path: 'web' } });
    const preview = d.cli('relevant', 'c-1');
    assert.equal(preview.code, 0, preview.err);
    assert.match(preview.out, /modified +app:src\/auth\/token\.ts/);
    assert.match(preview.out, /Would deliver 1 item.*filtered as unrelated: 1/);
    assert.match(preview.out, /finding +auth-bug/);
    const again = d.cli('relevant', 'c-1', '--json').json().data;
    assert.equal(again.delta.items.length, 1, 'preview did not consume the item');
    const status = d.cli('status', '--json').json().data;
    assert.deepEqual(status.sessions.find((s: { session: { id: string } }) => s.session.id === d.alice.id).counts, { pending: 0, delivered: 0, acknowledged: 0 });
    assert.equal(d.cli('relevant', 'c-1', '--level', 'huge').code, 2);
  } finally { d.done(); }
});

test('stale merges and missing ids are explained, not dumped as stack traces', () => {
  const d = demo();
  try {
    const c1 = d.aliceAgent.publish(d.alice.branchId, { kind: 'finding', key: 'a', body: 'a', scope: { type: 'workspace' } });
    const c2 = d.bobAgent.publish(d.bob.branchId, { kind: 'finding', key: 'b', body: 'b', scope: { type: 'workspace' } });
    const first = d.cli('merge', 'create', 'alice', 'main', c1.id, '--json').json().data;
    const second = d.cli('merge', 'create', 'bob', 'main', c2.id, '--json').json().data;
    assert.equal(d.cli('review', 'approve', second.reviewId).code, 0);

    const stale = d.cli('review', 'approve', first.reviewId);
    assert.equal(stale.code, 5);
    assert.match(stale.err, /error \[STALE\]/);
    assert.match(stale.err, /hint: .*new merge request/);
    assert.doesNotMatch(stale.err, /at .*\.ts:\d+/);

    const missing = d.cli('merge', 'show', 'ffffffff', '--json');
    assert.equal(missing.code, 4);
    assert.equal(missing.json().ok, false);
    assert.equal(d.cli('merge', 'list', '--all', '--json').json().data.length, 2);
  } finally { d.done(); }
});

test('the CLI uses the same data directory and SQLite file as the gateway daemon', () => {
  const gatewayDir = mkdtempSync(join(tmpdir(), 'agentree-gw-'));
  const cliDir = mkdtempSync(join(tmpdir(), 'agentree-cli-home-'));
  const io = (env: NodeJS.ProcessEnv) => ({ out: () => undefined, err: () => undefined, env: { AGENTREE_USER: 'reviewer', ...env }, cwd: '/repo' });
  try {
    assert.equal(DB_FILE, 'gateway.sqlite');
    // GATEWAY_DATA_DIR is honoured, exactly like `npm start` (src/index.ts).
    assert.equal(run(['init', 'shared'], io({ GATEWAY_DATA_DIR: gatewayDir })), 0);
    assert.ok(existsSync(join(gatewayDir, 'gateway.sqlite')));
    // AGENTREE_HOME still wins when both are set.
    assert.equal(run(['init', 'mine'], io({ GATEWAY_DATA_DIR: gatewayDir, AGENTREE_HOME: cliDir })), 0);
    assert.ok(existsSync(join(cliDir, 'gateway.sqlite')));
    // Default matches the gateway's default directory.
    assert.equal(agentreeHome({}), join(homedir(), '.local', 'share', 'agentree'));
  } finally {
    rmSync(gatewayDir, { recursive: true, force: true });
    rmSync(cliDir, { recursive: true, force: true });
  }
});
