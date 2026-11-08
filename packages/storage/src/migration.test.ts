import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SqliteStore } from './index.js';
import { AgentreeService } from '../../core/src/index.js';
import type { BranchWork, MainEntry, Workspace } from '../../contracts/src/index.js';

function legacyV1(adoptMain = true) {
  const directory = mkdtempSync(join(tmpdir(), 'agentree-v1-'));
  const path = join(directory, 'state.sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(readFileSync(new URL('./fixtures/v1.sql', import.meta.url), 'utf8'));
  const insert = (id: string, kind: string, data: unknown) => db.prepare('INSERT INTO entities(id,kind,data) VALUES(?,?,?)').run(id, kind, JSON.stringify(data));
  insert('w', 'workspace', { id: 'w', name: 'legacy', roots: [{ id: 'repo', path: '/repo' }] });
  insert('a', 'agent', { id: 'a', name: 'author' });
  insert('main', 'branch', { id: 'main', name: adoptMain ? 'main' : 'legacy', workspaceId: 'w', revision: 4, restricted: false });
  insert('draft', 'branch', { id: 'draft', name: 'draft', workspaceId: 'w', revision: 1, restricted: false });
  insert('s', 'session', { id: 's', agentId: 'a', workspaceId: 'w', branchId: 'draft', runtime: 'test', nativeId: 'native' });
  const old = [
    { kind: 'decision', key: 'api', body: 'superseded', scope: { type: 'workspace' } },
    { kind: 'decision', key: 'api', body: 'accepted guidance', scope: { type: 'workspace' } },
    { kind: 'finding', key: 'note', body: 'accepted finding', scope: { type: 'workspace' } },
    { kind: 'decision', key: 'file', body: 'file guidance', scope: { type: 'file', rootId: 'repo', path: 'src\\./a.ts' } },
  ].map((knowledge, i) => ({ id: `c${i + 1}`, workspaceId: 'w', branchId: 'main', revision: i + 1,
    knowledge, provenance: { sessionId: 's', eventIds: [] }, createdAt: '2026-01-01T00:00:00Z' }));
  for (const [i, commit] of old.entries()) {
    insert(commit.id, 'commit', commit);
    db.prepare('INSERT INTO branch_commits(branch_id,commit_id,revision) VALUES(?,?,?)').run('main', commit.id, i + 1);
  }
  const local = { id: 'local1', workspaceId: 'w', branchId: 'draft', revision: 1,
    knowledge: { kind: 'finding', key: 'local', body: 'unaccepted local proposal', scope: { type: 'workspace' } },
    provenance: { sessionId: 's', eventIds: [] }, createdAt: '2026-01-02T00:00:00Z' };
  insert(local.id, 'commit', local);
  db.prepare('INSERT INTO branch_commits(branch_id,commit_id,revision) VALUES(?,?,?)').run('draft', local.id, 1);
  insert('pending-merge', 'merge', { id: 'pending-merge', workspaceId: 'w', sourceBranchId: 'draft', targetBranchId: 'main', commitIds: ['local1'], expectedRevision: 0, state: 'pending' });
  for (const seq of [3, 9]) {
    const event = { id: `e${seq}`, workspaceId: 'w', source: 'native', nativeId: `e${seq}`, type: 'message', mode: 'observed', payload: {}, occurredAt: '2026-01-01T00:00:00Z' };
    db.prepare('INSERT INTO events(rowid,id,workspace_id,source,native_id,data) VALUES(?,?,?,?,?,?)').run(seq, event.id, 'w', 'native', event.nativeId, JSON.stringify(event));
  }
  db.close();
  return { directory, path, old };
}

function legacyV2() {
  const directory = mkdtempSync(join(tmpdir(), 'agentree-v2-'));
  const path = join(directory, 'state.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE entities(id TEXT PRIMARY KEY,kind TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE branch_commits(branch_id TEXT NOT NULL,commit_id TEXT NOT NULL,revision INTEGER NOT NULL,UNIQUE(branch_id,revision),PRIMARY KEY(branch_id,commit_id));
    CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,workspace_id TEXT NOT NULL,source TEXT NOT NULL,native_id TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(workspace_id,source,native_id));
    CREATE TABLE decision_changes(branch_id TEXT NOT NULL,revision INTEGER NOT NULL,identity TEXT NOT NULL,commit_id TEXT,PRIMARY KEY(branch_id,identity,revision));
    INSERT INTO entities VALUES('w','workspace','{"id":"w","name":"v2","roots":[],"mainBranchId":"m"}');
    INSERT INTO entities VALUES('m','branch','{"id":"m","workspaceId":"w","name":"main","revision":1,"restricted":true}');
    INSERT INTO entities VALUES('b','branch','{"id":"b","workspaceId":"w","name":"draft","revision":0,"restricted":false}');
    INSERT INTO entities VALUES('commit','commit','{"id":"commit","workspaceId":"w","branchId":"m","revision":1,"knowledge":{"kind":"finding","body":"v2 accepted","scope":{"type":"workspace"}},"provenance":{"sessionId":"legacy-session","eventIds":[]},"createdAt":"2026-01-01T00:00:00Z"}');
    INSERT INTO branch_commits VALUES('m','commit',1);
    PRAGMA user_version=2;`);
  db.close();
  return { directory, path };
}

test('v1 migration projects accepted Main and pending local work once, preserving legacy evidence', () => {
  const f = legacyV1();
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(f.path);
    const human = new AgentreeService(store, { type: 'human', id: 'reviewer' });
    const main = human.main('w');
    assert.equal(main.revision, 4);
    assert.deepEqual(main.entries.map(e => e.id), ['legacy-main:c2', 'legacy-main:c3', 'legacy-main:c4']);
    assert.deepEqual(human.mainHistory('w', 'legacy-main:c1').map(e => e.removed), [true]);
    assert.deepEqual(main.entries.find(e => e.id === 'legacy-main:c4')?.files, [{ rootId: 'repo', path: 'src/a.ts' }]);
    const local = store.get<BranchWork>('legacy-work:local1', 'branch-work')!;
    assert.equal(local.state, 'proposed', 'a pending legacy review does not imply acceptance');
    assert.equal(local.body, 'unaccepted local proposal');
    assert.ok(store.get('local1', 'commit'), 'legacy source record remains intact');
    assert.deepEqual(human.events('w', { source: 'native' }).events.map(e => e.sequence), [3, 9]);
    assert.equal(Number(store.db.prepare('PRAGMA user_version').get()!.user_version), 3);
    const revision = store.list<{id:string}>('main-revision')[0]!;
    assert.throws(() => store!.db.prepare("UPDATE entities SET data=? WHERE id=?").run('{}', revision.id), /immutable/i);
    assert.equal(store.events<{ type?: string }>().filter(e => e.type === 'storage.supervision-migrated').length, 1);
    store.close();
    store = new SqliteStore(f.path);
    assert.equal(new AgentreeService(store, { type: 'human', id: 'reviewer' }).main('w').entries.length, 3);
    assert.equal(store.get<Workspace>('w')!.mainBranchId, 'main');
    assert.equal(store.list<MainEntry>('main-entry').length, 4);
  } finally { store?.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('v1 workspace without an old Main adopts one and keeps all local content as proposed work', () => {
  const f = legacyV1(false);
  const store = new SqliteStore(f.path);
  try {
    const human = new AgentreeService(store, { type: 'human', id: 'reviewer' });
    assert.equal(human.main('w').entries.length, 0);
    assert.ok(human.workspace('w').mainBranchId);
    assert.equal(store.get<BranchWork>('legacy-work:c1', 'branch-work')?.state, 'proposed');
    assert.equal(store.get<{state:string}>('pending-merge')?.state, 'pending');
  } finally { store.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('v2 migration and restart retain materialized Main and schema version 3', () => {
  const f = legacyV2();
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(f.path);
    const human = new AgentreeService(store, { type: 'human', id: 'reviewer' });
    assert.equal(human.main('w').entries[0]?.body, 'v2 accepted');
    assert.equal(human.main('w').entries[0]?.legacyCommitId, 'commit');
    assert.equal(Number(store.db.prepare('PRAGMA user_version').get()!.user_version), 3);
    store.close();
    store = new SqliteStore(f.path);
    assert.equal(new AgentreeService(store, { type: 'human', id: 'reviewer' }).main('w').entries.length, 1);
    assert.equal(store.list<MainEntry>('main-entry').length, 1);
  } finally { store?.close(); rmSync(f.directory, { recursive: true, force: true }); }
});
