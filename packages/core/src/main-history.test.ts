import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PendingTreeService } from './index.js';
import { DomainError } from '../../contracts/src/index.js';
import { SqliteStore } from '../../storage/src/index.js';

function fixture() {
  const store = new SqliteStore(':memory:');
  const human = new PendingTreeService(store, { type: 'human', id: 'reviewer' });
  const restorer = new PendingTreeService(store, { type: 'human', id: 'restorer' });
  const workspace = human.createWorkspace('history', [{ id: 'repo', path: '/tmp/repo' }]);
  const other = human.createWorkspace('other');
  const a = human.editMain(workspace.id, { body: 'first', files: [{ rootId: 'repo', path: 'a.ts' }] }, 0);
  const b = human.editMain(workspace.id, { body: 'second' }, 1);
  return { store, human, restorer, workspace, other, a, b };
}
const code = (wanted: string) => (error: unknown) => error instanceof DomainError && error.code === wanted;

test('Main global revisions reconstruct immutable snapshots and carry the human restoration provenance', () => {
  const f = fixture();
  try {
    const historical = f.human.mainAtRevision(f.workspace.id, 1);
    assert.equal(historical.revision, 1);
    assert.deepEqual(historical.entries.map(e => [e.id, e.body, e.files]), [[f.a.id, 'first', [{ rootId: 'repo', path: 'a.ts' }]]]);
    assert.deepEqual(historical.removedEntries, []);
    const revisions = f.human.mainHistory(f.workspace.id);
    assert.deepEqual(revisions.map(r => [r.revision, r.entryIds]), [[1, [f.a.id]], [2, [f.b.id]]]);

    const restored = f.restorer.restoreMain(f.workspace.id, 1, 2);
    assert.equal(restored.revision, 3);
    assert.deepEqual(restored.entries.map(e => e.id), [f.a.id]);
    assert.deepEqual(restored.removedEntries.map(e => e.id), [f.b.id]);
    const ah = f.human.mainHistory(f.workspace.id, f.a.id);
    const restoredA = ah.at(-1)!;
    assert.equal(restoredA.revision, 3);
    assert.equal(restoredA.body, 'first');
    assert.deepEqual(restoredA.restoredFrom, { revision: 1, entryRevision: 1 });
    assert.deepEqual(f.human.mainHistory(f.workspace.id, f.a.id)[0]?.actor, { type: 'human', id: 'reviewer' }, 'original authorship remains immutable');
    assert.deepEqual(restoredA.actor, { type: 'human', id: 'restorer' });
    const restoredB = f.human.mainHistory(f.workspace.id, f.b.id).at(-1)!;
    assert.equal(restoredB.removed, true);
    assert.deepEqual(restoredB.restoredFrom, { revision: 1 });
    assert.deepEqual(f.human.mainHistory(f.workspace.id).at(-1)?.restoredFromRevision, 1);
    assert.deepEqual(f.human.mainAtRevision(f.workspace.id, 2).entries.map(e => e.body), ['first', 'second']);
  } finally { f.store.close(); }
});

test('entry restoration selects a global snapshot, can revive a removed state, and always consumes one revision', () => {
  const f = fixture();
  try {
    f.human.editMain(f.workspace.id, { body: 'changed text', files: [{ rootId: 'repo', path: 'changed.ts' }] }, 2, f.a.id);
    f.human.editMain(f.workspace.id, { body: 'changed text' }, 3, f.a.id, true);
    const restoredRemoved = f.restorer.restoreMain(f.workspace.id, 4, 4, f.a.id);
    assert.equal(restoredRemoved.revision, 5);
    assert.equal(restoredRemoved.removed, true, 'entry restore copies the historical removed state too');
    const restored = f.restorer.restoreMain(f.workspace.id, 1, 5, f.a.id);
    assert.equal(restored.revision, 6);
    assert.equal(restored.id, f.a.id);
    assert.equal(restored.body, 'first');
    assert.deepEqual(restored.files, [{ rootId: 'repo', path: 'a.ts' }]);
    assert.equal(restored.removed, false);
    assert.deepEqual(restored.restoredFrom, { revision: 1, entryRevision: 1 });
    const same = f.restorer.restoreMain(f.workspace.id, 1, 6);
    assert.equal(same.revision, 7, 'same-content whole restore still advances exactly once');
  } finally { f.store.close(); }
});

test('history rejects stale, invalid, future, and cross-workspace requests', () => {
  const f = fixture();
  try {
    const before = f.human.main(f.workspace.id);
    assert.throws(() => f.human.restoreMain(f.workspace.id, 1, 1), code('STALE'));
    assert.throws(() => f.human.mainAtRevision(f.workspace.id, -1));
    assert.throws(() => f.human.mainAtRevision(f.workspace.id, 3));
    assert.throws(() => f.human.mainAtRevision(f.other.id, 1));
    assert.throws(() => f.human.mainHistory(f.other.id, f.a.id), code('NOT_FOUND'));
    assert.throws(() => f.human.restoreMain(f.other.id, 0, 0, f.a.id), code('NOT_FOUND'));
    assert.throws(() => f.human.restoreMain(f.workspace.id, 20, 2), code('NOT_FOUND'));
    assert.deepEqual(f.human.main(f.workspace.id), before, 'rejected target requests leave current Main untouched');
  } finally { f.store.close(); }
});

test('agents cannot remove or restore Main and an empty restore is a durable immutable global history event', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pendingtree-empty-restore-'));
  const path = join(directory, 'history.sqlite');
  let store = new SqliteStore(path);
  try {
    const human = new PendingTreeService(store, { type: 'human', id: 'reviewer' });
    const workspace = human.createWorkspace('empty');
    const branch = human.createBranch(workspace.id, 'agent-branch');
    const session = human.registerSession(branch.id, { id: 'agent', name: 'Agent' }, 'native', 'native-session');
    const agent = new PendingTreeService(store, { type: 'agent', sessionId: session.id });
    const emptyRestore = human.restoreMain(workspace.id, 0, 0);
    assert.equal(emptyRestore.revision, 1);
    assert.deepEqual(emptyRestore.entries, []);
    assert.deepEqual(emptyRestore.removedEntries, []);
    const marker = human.mainHistory(workspace.id)[0]!;
    assert.equal(marker.revision, 1);
    assert.deepEqual(marker.entryIds, []);
    assert.equal(marker.restoredFromRevision, 0);
    assert.deepEqual(marker.actor, { type: 'human', id: 'reviewer' });
    const next = human.editMain(workspace.id, { body: 'ordinary edit after restore' }, 1);
    assert.equal(next.revision, 2);
    assert.deepEqual(human.mainHistory(workspace.id).map(r => r.revision), [1, 2]);
    const removed = human.removeMain(workspace.id, next.id, 2);
    assert.equal(removed.removed, true);
    assert.throws(() => agent.removeMain(workspace.id, next.id, 3), code('DENY'));
    assert.throws(() => agent.restoreMain(workspace.id, 0, 3), code('DENY'));
    assert.equal(session.workspaceId, workspace.id);
    store.close();
    store = new SqliteStore(path);
    const restartedHuman = new PendingTreeService(store, { type: 'human', id: 'reviewer' });
    assert.deepEqual(restartedHuman.mainHistory(workspace.id)[0], marker, 'empty restoration marker survives restart unchanged');
    assert.deepEqual(restartedHuman.mainHistory(workspace.id).map(r => r.revision), [1, 2, 3]);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a storage failure during whole restoration rolls back every entry and the global revision', () => {
  const f = fixture();
  try {
    const ledgerBefore = f.store.list('main-revision');
    const auditBefore = f.human.events(f.workspace.id).events.filter(e => e.type === 'main.restored' || e.type === 'main.snapshot-restored');
    f.store.db.exec(`CREATE TRIGGER fail_main_restore BEFORE UPDATE ON entities
      WHEN OLD.kind = 'main-entry' AND json_extract(OLD.data, '$.id') = '${f.b.id}'
      BEGIN SELECT RAISE(ABORT, 'injected second-entry rollback failure'); END`);
    assert.throws(() => f.human.restoreMain(f.workspace.id, 1, 2));
    assert.equal(f.human.main(f.workspace.id).revision, 2);
    assert.deepEqual(f.human.main(f.workspace.id).entries.map(e => [e.id, e.body]), [[f.a.id, 'first'], [f.b.id, 'second']]);
    assert.deepEqual(f.human.mainHistory(f.workspace.id).map(r => r.revision), [1, 2]);
    assert.deepEqual(f.store.list('main-revision'), ledgerBefore, 'the earlier entry write was rolled back from immutable history too');
    assert.deepEqual(f.human.events(f.workspace.id).events.filter(e => e.type === 'main.restored' || e.type === 'main.snapshot-restored'), auditBefore);
    f.store.db.exec('DROP TRIGGER fail_main_restore');
  } finally { f.store.close(); }
});

test('restoration preserves source work provenance and records the restoring human as actor', () => {
  const store = new SqliteStore(':memory:');
  try {
    const human = new PendingTreeService(store, { type: 'human', id: 'human-reviewer' });
    const workspace = human.createWorkspace('provenance');
    const branch = human.createBranch(workspace.id, 'author');
    const session = human.registerSession(branch.id, { id: 'agent', name: 'Agent' }, 'native', 'session');
    const agent = new PendingTreeService(store, { type: 'agent', sessionId: session.id });
    const proposal = agent.proposeWork(branch.id, { body: 'accepted source' });
    human.decideMerge(branch.id, [proposal.id], 'accepted', 0);
    const acceptedEntry = human.main(workspace.id).entries[0]!;
    assert.equal(acceptedEntry.sourceWorkId, proposal.id);
    human.editMain(workspace.id, { body: 'temporary edit' }, 1, acceptedEntry.id);
    const restored = human.restoreMain(workspace.id, 1, 2, acceptedEntry.id);
    assert.equal(restored.body, 'accepted source');
    assert.equal(restored.sourceWorkId, proposal.id);
    assert.deepEqual(restored.actor, { type: 'human', id: 'human-reviewer' });
    assert.equal(restored.restoredFrom?.revision, 1);
  } finally { store.close(); }
});

test('restored and historical Main versions survive a database restart unchanged', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pendingtree-main-history-'));
  const path = join(directory, 'history.sqlite');
  let store = new SqliteStore(path);
  let human = new PendingTreeService(store, { type: 'human', id: 'durable-reviewer' });
  const workspace = human.createWorkspace('durable');
  const entry = human.editMain(workspace.id, { body: 'original' }, 0);
  human.editMain(workspace.id, { body: 'newer' }, 1, entry.id);
  const restored = human.restoreMain(workspace.id, 1, 2, entry.id);
  store.close();
  try {
    store = new SqliteStore(path);
    human = new PendingTreeService(store, { type: 'human', id: 'durable-reviewer' });
    assert.equal(human.main(workspace.id).revision, 3);
    assert.equal(human.main(workspace.id).entries[0]?.body, 'original');
    assert.deepEqual(human.mainHistory(workspace.id, entry.id).map(e => [e.revision, e.body]), [[1, 'original'], [2, 'newer'], [3, 'original']]);
    assert.deepEqual(human.mainHistory(workspace.id, entry.id).at(-1)?.restoredFrom, restored.restoredFrom);
    assert.deepEqual(human.mainHistory(workspace.id).map(r => r.revision), [1, 2, 3]);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('independent SQLite connections reject a stale Main writer', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pendingtree-main-writers-'));
  const path = join(directory, 'history.sqlite');
  const firstStore = new SqliteStore(path);
  let secondStore: SqliteStore | undefined;
  try {
    const first = new PendingTreeService(firstStore, { type: 'human', id: 'reviewer' });
    const workspace = first.createWorkspace('writers');
    secondStore = new SqliteStore(path);
    const second = new PendingTreeService(secondStore, { type: 'human', id: 'reviewer' });
    first.editMain(workspace.id, { body: 'committed by writer one' }, 0);
    assert.throws(() => second.editMain(workspace.id, { body: 'stale writer two' }, 0), code('STALE'));
    assert.deepEqual(second.main(workspace.id).entries.map(e => e.body), ['committed by writer one']);
    assert.equal(second.main(workspace.id).revision, 1);
  } finally { secondStore?.close(); firstStore.close(); rmSync(directory, { recursive: true, force: true }); }
});
