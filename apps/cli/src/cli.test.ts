import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PendingTreeService } from '../../../packages/core/src/index.js';
import { SqliteStore } from '../../../packages/storage/src/index.js';
import { run } from './cli.js';

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'pendingtree-cli-'));
  const cli = (...argv: string[]) => { const out: string[] = [], err: string[] = []; const code = run(argv, { out: t => out.push(t), err: t => err.push(t), env: { PENDINGTREE_HOME: home, PENDINGTREE_USER: 'reviewer' }, cwd: '/repo' }); return { code, out: out.join('\n'), err: err.join('\n'), json: () => JSON.parse(out.join('\n')) }; };
  return { home, cli, close: () => rmSync(home, { recursive: true, force: true }) };
}

test('workspace, branch and session setup remain available', () => {
  const f = setup();
  try {
    assert.equal(f.cli('--help').code, 0); assert.match(f.cli('--help').out, /main add/);
    const w = f.cli('init', 'demo', '--root', 'app=/repo', '--json').json().data;
    assert.equal(f.cli('branch', 'create', 'agent-a').code, 0);
    const s = f.cli('session', 'register', 'agent-a', '--agent', 'a', '--runtime', 'mock', '--native', 'native-a', '--json').json().data;
    assert.ok(s.id); assert.equal(f.cli('workspace', 'show', '--json').json().data.id, w.id);
    assert.equal(f.cli('status', '--json').json().data.branches.length, 1);
  } finally { f.close(); }
});

test('human can edit Main and retrieve immutable entry history', () => {
  const f = setup();
  try {
    f.cli('init', 'demo', '--root', 'app=/repo');
    const created = f.cli('main', 'add', 'Keep request IDs', '--file', 'app=src/api.ts', '--json').json().data;
    const updated = f.cli('main', 'edit', created.id, 'Keep request IDs in error responses', '--json').json().data;
    assert.equal(updated.revision, 2);
    const history = f.cli('main', 'history', created.id, '--json').json().data;
    assert.deepEqual(history.map((e: { revision: number }) => e.revision), [1, 2]);
    const removed = f.cli('main', 'remove', created.id, '--json').json().data; assert.equal(removed.removed, true);
    assert.equal(f.cli('main', '--json').json().data.entries.length, 0);
    assert.equal(f.cli('main', 'history', created.id, '--json').json().data.length, 3);
  } finally { f.close(); }
});

test('human supervises proposed work, conflict disposition, correction, and Main acceptance', () => {
  const f = setup();
  try {
    const w = f.cli('init', 'demo', '--root', 'app=/repo', '--json').json().data; f.cli('branch', 'create', 'a'); f.cli('branch', 'create', 'b');
    const a = f.cli('session', 'register', 'a', '--agent', 'a', '--runtime', 'mock', '--native', 'na', '--json').json().data;
    f.cli('session', 'register', 'b', '--agent', 'b', '--runtime', 'mock', '--native', 'nb');
    const store = new SqliteStore(join(f.home, 'gateway.sqlite')); const agent = new PendingTreeService(store, { type: 'agent', sessionId: a.id });
    const main = f.cli('main', 'add', 'Use the x-request-id header', '--file', 'app=src/api.ts', '--json').json().data;
    const work = agent.proposeWork(a.branchId, { body: 'Changed the response header', files: [{ rootId: 'app', path: 'src/api.ts' }], conflictsWithMain: [main.id] });
    const listed = f.cli('work', 'list', 'a', '--json').json().data; assert.equal(listed.length, 1);
    const conflict = f.cli('conflict', 'list', '--json').json().data.find((c: { mainEntryId?: string; branchIds: string[] }) => c.mainEntryId === main.id && c.branchIds.includes(a.branchId));
    assert.ok(conflict); assert.equal(f.cli('conflict', 'decide', conflict.id, 'confirmed', 'Agent reported incompatibility with active header requirement.').code, 0);
    assert.equal(f.cli('correction', 'send', 'a', 'Preserve x-request-id in error responses.', '--json').json().data.branchId, a.branchId);
    assert.equal(f.cli('work', 'accept', 'a', work.id, '--json').code, 5);
    const accepted = f.cli('work', 'accept', 'a', work.id, '--override-conflicts', '--json').json().data;
    assert.equal(accepted.overrideConflicts, true); assert.equal(accepted.state, 'accepted');
    assert.ok(f.cli('main', '--json').json().data.entries.some((e: { sourceWorkId?: string }) => e.sourceWorkId === work.id));
    assert.equal(f.cli('--as', a.id, 'main', 'add', 'forbidden', '--json').code, 3);
    assert.equal(f.cli('merge', 'nonsense').code, 2); assert.equal(w.name, 'demo');
    store.close();
  } finally { f.close(); }
});

test('native event activity remains queryable and usage errors are readable', () => {
  const f = setup();
  try {
    f.cli('init', 'demo', '--root', 'app=/repo'); f.cli('branch', 'create', 'a');
    const s = f.cli('session', 'register', 'a', '--agent', 'a', '--runtime', 'mock', '--native', 'native-a', '--json').json().data;
    const store = new SqliteStore(join(f.home, 'gateway.sqlite')); const svc = new PendingTreeService(store, { type: 'agent', sessionId: s.id });
    svc.ingest({ id: 'event-1', workspaceId: s.workspaceId, source: 'mock', nativeId: 'event-1', sessionId: s.id, type: 'tool.call', mode: 'observed', payload: { tool: 'Edit', input: { file_path: '/repo/a.ts' } }, occurredAt: new Date().toISOString() }); store.close();
    assert.match(f.cli('log', '--session', 'native-a').out, /Edit \/repo\/a\.ts/);
    assert.equal(f.cli('correction', 'send', 'missing', 'hello').code, 4);
    assert.equal(f.cli('unknown').code, 2);
  } finally { f.close(); }
});

test('managed session identity environment cannot be overridden with --as', () => {
  const home = mkdtempSync(join(tmpdir(), 'pendingtree-managed-cli-'));
  try {
    const out: string[] = [], err: string[] = [];
    const code = run(['--as', 'another-session', 'status'], {
      out: text => out.push(text), err: text => err.push(text),
      env: { PENDINGTREE_HOME: home, PENDINGTREE_USER: 'reviewer', HARNESS_SESSION_ID: 'managed-session', HARNESS_SESSION_TOKEN: 'managed-token' },
      cwd: '/repo',
    });
    assert.equal(code, 3);
    assert.match(err.join('\n'), /managed session/i);
    assert.deepEqual(out, []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
