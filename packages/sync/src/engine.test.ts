import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Session } from '../../contracts/src/index.js';
import { AgentreeService } from '../../core/src/index.js';
import { SqliteStore } from '../../storage/src/index.js';
import { ContextSync, EntityLedger } from './index.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'agentree-sync-')); const store = new SqliteStore(join(dir, 'agentree.sqlite'));
  const human = new AgentreeService(store, { type: 'human', id: 'reviewer' }); const workspace = human.createWorkspace('demo', [{ id: 'app', path: '/repo' }]);
  const a = human.createBranch(workspace.id, 'a'); const b = human.createBranch(workspace.id, 'b');
  const sa = human.registerSession(a.id, { id: 'a', name: 'A' }, 'claude', 'a'); const sb = human.registerSession(b.id, { id: 'b', name: 'B' }, 'codex', 'b');
  const agent = (s: Session) => new AgentreeService(store, { type: 'agent', sessionId: s.id });
  const sync = (s: Session) => new ContextSync(agent(s), new EntityLedger(store));
  return { dir, store, human, workspace, a, b, sa, sb, aa: agent(sa), ab: agent(sb), sync, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('retrieves a complete authoritative Main snapshot once and sends a newer snapshot after edit/removal', () => {
  const f = fixture();
  try {
    const entry = f.human.editMain(f.workspace.id, { body: 'Preserve request IDs', files: [{ rootId: 'app', path: 'src/api.ts' }] }, 0);
    const sync = f.sync(f.sb); const first = sync.sync({ session: f.sb, requestId: 'first' });
    assert.deepEqual(first.items.map(i => i.kind), ['main']);
    assert.deepEqual((first.items[0]!.value as { entries: unknown[] }).entries.length, 1);
    assert.equal(sync.sync({ session: f.sb }).items.length, 0);
    const edited = f.human.editMain(f.workspace.id, { body: 'Preserve request IDs and trace IDs', files: [{ rootId: 'app', path: 'src/api.ts' }] }, 1, entry.id);
    const second = sync.sync({ session: f.sb }); assert.equal(second.mainRevision, 2);
    assert.equal((second.items[0]!.value as { entries: Array<{ body: string }> }).entries[0]!.body, edited.body);
    f.human.editMain(f.workspace.id, { body: edited.body, files: edited.files }, 2, entry.id, true);
    const removed = sync.sync({ session: f.sb });
    const snapshot = removed.items[0]!.value as { entries: unknown[]; removedEntries: Array<{ id: string }> };
    assert.equal(snapshot.entries.length, 0); assert.equal(snapshot.removedEntries[0]!.id, entry.id);
  } finally { f.close(); }
});

test('exposes sibling proposals and targeted corrections; acknowledgement and retry survive restart', () => {
  const f = fixture();
  try {
    f.aa.proposeWork(f.a.id, { body: 'Updated src/auth.ts', files: [{ rootId: 'app', path: 'src/auth.ts' }] });
    assert.equal(f.ab.proposeWork(f.b.id, { body: 'Own proposal', files: [] }).state, 'proposed');
    f.human.sendCorrection(f.b.id, 'Use the existing request header.');
    const sync = f.sync(f.sb); const delta = sync.sync({ session: f.sb, requestId: 'pull' });
    assert.ok(delta.items.some(i => i.kind === 'main'));
    assert.ok(delta.items.some(i => i.kind === 'work' && (i.value as { body: string }).body === 'Updated src/auth.ts'));
    assert.ok(!delta.items.some(i => i.kind === 'work' && (i.value as { body: string }).body === 'Own proposal'));
    assert.ok(delta.items.some(i => i.kind === 'correction'));
    assert.deepEqual(sync.sync({ session: f.sb, requestId: 'pull' }), delta);
    const ids = delta.items.map(i => i.itemId); assert.equal(sync.acknowledge(f.sb.id, ids), ids.length);
    const reopened = new ContextSync(f.ab, new EntityLedger(f.store));
    assert.equal(reopened.sync({ session: f.sb }).items.length, 0);
    assert.equal(reopened.status(f.sb.id).counts.acknowledged, ids.length);
  } finally { f.close(); }
});

test('legacy context delivery ledgers are left archival and cannot replay stale payloads', () => {
  const f = fixture();
  try {
    f.store.put('sync_ledger:legacy-session', 'sync_ledger', {
      id: 'sync_ledger:legacy-session', sessionId: 'legacy-session',
      items: { old: { itemId: 'old', authority: 'finding', state: 'pending', attempts: 1, firstSeenAt: 'yesterday' } },
      lastPull: { requestId: 'old-request', delta: { kind: 'agentree.context-delta', obsolete: true } },
    });
    const ledger = new EntityLedger(f.store);
    assert.deepEqual(ledger.load('legacy-session'), { sessionId: 'legacy-session', items: {} });
    ledger.save({ sessionId: 'legacy-session', items: {} });
    assert.ok(f.store.get('sync_ledger:legacy-session'));
    assert.ok(f.store.get('supervision_ledger:legacy-session'));
  } finally { f.close(); }
});
