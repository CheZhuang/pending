import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentreeService } from './index.js';
import { DomainError, type Knowledge, type NormalizedEvent } from '../../contracts/src/index.js';
import { SqliteStore } from '../../storage/src/index.js';

function fixture(roots: Array<{ id: string; path: string }> = []) {
  const directory = mkdtempSync(join(tmpdir(), 'agentree-sharing-'));
  const path = join(directory, 'agentree.sqlite');
  const store = new SqliteStore(path);
  const human = new AgentreeService(store, { type: 'human', id: 'human-reviewer' });
  const workspace = human.createWorkspace('shared', roots);
  const alice = human.createBranch(workspace.id, 'alice');
  const bob = human.createBranch(workspace.id, 'bob');
  const aliceSession = human.registerSession(alice.id, { id: 'agent-alice', name: 'Alice' }, 'codex', 'native-alice');
  const bobSession = human.registerSession(bob.id, { id: 'agent-bob', name: 'Bob' }, 'claude', 'native-bob');
  return {
    directory, path, store, human, workspace, alice, bob, aliceSession, bobSession,
    aliceAgent: new AgentreeService(store, { type: 'agent', sessionId: aliceSession.id }),
    bobAgent: new AgentreeService(store, { type: 'agent', sessionId: bobSession.id }),
  };
}

const finding = (key: string, body: string, scope: Knowledge['scope'] = { type: 'workspace' }): Knowledge => ({ kind: 'finding', key, body, scope });
const decision = (key: string, body: string, scope: Knowledge['scope'], impactScope?: Knowledge['impactScope']): Knowledge => ({ kind: 'decision', key, body, scope, ...(impactScope ? { impactScope } : {}) });
const errCode = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;

function event(workspaceId: string, sessionId: string, nativeId: string, type = 'message'): NormalizedEvent {
  return { id: `event-${nativeId}`, workspaceId, source: 'runtime-a', nativeId, sessionId, type, mode: 'observed', payload: { nativeId }, occurredAt: new Date().toISOString() };
}

test('agent branches inherit reviewed main updates live while snapshots pin history across reopen', () => {
  const f = fixture();
  try {
    const first = f.aliceAgent.publish(f.alice.id, finding('shared', 'first main finding'));
    const firstMerge = f.human.createMerge(f.alice.id, f.workspace.mainBranchId, [first.id], 0, 0);
    assert.ok(firstMerge.reviewId);
    f.human.resolveReview(firstMerge.reviewId!, 'approved');
    f.human.applyMerge(firstMerge.id);

    const bobBefore = f.bobAgent.snapshot(f.bob.id);
    assert.deepEqual(bobBefore.history.map(c => c.id), [first.id]);
    assert.deepEqual(bobBefore.entries.map(e => [e.commit.id, e.branchId, e.revision]), [[first.id, f.workspace.mainBranchId, 1]]);
    const branchRevisionBefore = f.store.get<{ revision: number }>(f.bob.id)!.revision;
    assert.deepEqual(f.bobAgent.contextRevision(f.bob.id), bobBefore.revision);

    const second = f.aliceAgent.publish(f.alice.id, finding('another', 'second main finding'));
    const secondMerge = f.human.createMerge(f.alice.id, f.workspace.mainBranchId, [second.id], 1, 1);
    f.human.resolveReview(secondMerge.reviewId!, 'approved');
    f.human.applyMerge(secondMerge.id);

    const live = f.bobAgent.snapshot(f.bob.id);
    assert.deepEqual(live.history.map(c => c.id), [first.id, second.id]);
    assert.deepEqual(live.knowledge.map(c => c.id), [first.id, second.id]);
    assert.deepEqual(live.revision, { branchRevision: 0, mainRevision: 2 });
    assert.deepEqual(f.bobAgent.contextRevision(f.bob.id), live.revision);
    assert.equal(f.store.get<{ revision: number }>(f.bob.id)!.revision, branchRevisionBefore);
    assert.deepEqual(f.bobAgent.snapshot(f.bob.id, bobBefore.revision).history.map(c => c.id), [first.id]);

    const pinned = bobBefore.revision;
    f.store.close();
    const restarted = new SqliteStore(f.path);
    try {
      const afterRestart = new AgentreeService(restarted, { type: 'agent', sessionId: f.bobSession.id });
      assert.deepEqual(afterRestart.snapshot(f.bob.id, pinned).history.map(c => c.id), [first.id]);
      assert.deepEqual(afterRestart.snapshot(f.bob.id).history.map(c => c.id), [first.id, second.id]);
      assert.deepEqual(afterRestart.snapshot(f.workspace.mainBranchId).entries.map(e => [e.branchId, e.revision]), [
        [f.workspace.mainBranchId, 1], [f.workspace.mainBranchId, 2],
      ]);
    } finally { restarted.close(); }
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('main is protected, and inherited decisions shadow only overlapping local proposals', () => {
  const f = fixture([{ id: 'src', path: '/project/src' }, { id: 'docs', path: '/project/docs' }]);
  try {
    assert.throws(() => f.human.registerSession(f.workspace.mainBranchId, { id: 'main-agent', name: 'Main' }, 'codex', 'main-native'), errCode('BRANCH'));
    const sourceScope = { type: 'file' as const, rootId: 'src', path: 'api/client.ts' };
    const docsScope = { type: 'file' as const, rootId: 'docs', path: 'api/client.ts' };
    const accepted = f.aliceAgent.publish(f.alice.id, decision('transport', 'HTTP', sourceScope));
    const merge = f.human.createMerge(f.alice.id, f.workspace.mainBranchId, [accepted.id], 0, 0);
    f.human.resolveReview(merge.reviewId!, 'approved');
    f.human.applyMerge(merge.id);

    const localDifferent = f.bobAgent.publish(f.bob.id, decision('transport', 'gRPC', sourceScope));
    const localDisjoint = f.bobAgent.publish(f.bob.id, decision('transport', 'docs use local links', docsScope));
    const current = f.bobAgent.snapshot(f.bob.id);
    assert.ok(current.history.some(c => c.id === localDifferent.id));
    assert.deepEqual(current.knowledge.filter(c => c.knowledge.kind === 'decision').map(c => c.id), [localDisjoint.id, accepted.id]);
    assert.equal(current.entries.find(e => e.commit.id === accepted.id)?.branchId, f.workspace.mainBranchId);

    const stale = current.revision;
    const next = f.aliceAgent.publish(f.alice.id, finding('later', 'new main state'));
    const nextMerge = f.human.createMerge(f.alice.id, f.workspace.mainBranchId, [next.id], 1, 1);
    f.human.resolveReview(nextMerge.reviewId!, 'approved');
    f.human.applyMerge(nextMerge.id);
    assert.throws(() => f.bobAgent.publish(f.bob.id, finding('stale-write', 'should fail'), [], stale), errCode('STALE'));
    assert.throws(() => f.human.createMerge(f.alice.id, f.workspace.mainBranchId, ['missing-commit'], 2, 2), errCode('MERGE'));
  } finally { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('main authorizes no direct drafts, merges check inherited main revision, and author/attachment revisions stay distinct', () => {
  const f = fixture();
  try {
    assert.throws(() => f.aliceAgent.publish(f.workspace.mainBranchId, finding('forbidden', 'draft')), errCode('DENY'));
    const original = f.aliceAgent.publish(f.alice.id, finding('one', 'author revision one'));
    const merge = f.human.createMerge(f.alice.id, f.workspace.mainBranchId, [original.id], 0, 0);

    const concurrent = f.bobAgent.publish(f.bob.id, finding('concurrent', 'advances main separately'));
    const concurrentMerge = f.human.createMerge(f.bob.id, f.workspace.mainBranchId, [concurrent.id], 0, 0);
    f.human.resolveReview(concurrentMerge.reviewId!, 'approved');
    f.human.applyMerge(concurrentMerge.id);
    assert.throws(() => f.human.resolveReview(merge.reviewId!, 'approved'), errCode('STALE'));
    assert.throws(() => f.human.applyMerge(merge.id), errCode('STALE'));

    const retry = f.human.createMerge(f.alice.id, f.workspace.mainBranchId, [original.id], 1, 1);
    f.human.resolveReview(retry.reviewId!, 'approved');
    f.human.applyMerge(retry.id);
    const main = f.human.snapshot(f.workspace.mainBranchId);
    assert.equal(main.entries.find(e => e.commit.id === original.id)?.revision, 2);
    assert.equal(main.history.find(c => c.id === original.id)?.revision, 1);
  } finally { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('review resolution can retain an existing decision without deleting the incoming proposal', () => {
  const f = fixture();
  try {
    const targetSession = f.human.registerSession(f.bob.id, { id: 'agent-bob', name: 'Bob' }, 'claude', 'native-bob');
    const targetAgent = new AgentreeService(f.store, { type: 'agent', sessionId: targetSession.id });
    const location = { type: 'file' as const, path: 'config/runtime.ts' };
    const existing = targetAgent.publish(f.bob.id, decision('runtime', 'stable', location));
    const incoming = f.aliceAgent.publish(f.alice.id, decision('runtime', 'experimental', location));
    const merge = f.human.createMerge(f.alice.id, f.bob.id, [incoming.id], 1, 0);
    assert.ok(merge.reviewId);
    const review = f.human.resolveReview(merge.reviewId!, 'approved', [{ existingCommitId: existing.id, incomingCommitId: incoming.id, selectedCommitId: existing.id }]);
    assert.equal(review.resolutions?.[0].selectedCommitId, existing.id);
    f.human.applyMerge(merge.id);
    const view = f.human.snapshot(f.bob.id);
    assert.ok(view.history.some(c => c.id === incoming.id));
    assert.equal(view.entries.find(e => e.commit.id === incoming.id)?.revision, 2);
    assert.equal(incoming.revision, 1);
    assert.equal(view.knowledge.find(c => c.knowledge.key === 'runtime')?.id, existing.id);
    assert.equal(f.human.store.get<typeof merge>(merge.id)?.state, 'applied');
  } finally { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('main decision replacement preserves old snapshots and history across reopen and is inherited by later branches', () => {
  const f = fixture();
  try {
    const location = { type: 'file' as const, path: 'config/runtime.ts' };
    const original = f.aliceAgent.publish(f.alice.id, decision('runtime', 'stable', location));
    const firstMerge = f.human.createMerge(f.alice.id, f.workspace.mainBranchId, [original.id], 0, 0);
    f.human.resolveReview(firstMerge.reviewId!, 'approved');
    f.human.applyMerge(firstMerge.id);
    const beforeReplacement = f.bobAgent.snapshot(f.bob.id);
    const pinnedMain = f.human.snapshot(f.workspace.mainBranchId);
    assert.equal(beforeReplacement.knowledge.find(c => c.knowledge.key === 'runtime')?.id, original.id);

    const replacement = f.bobAgent.publish(f.bob.id, decision('runtime', 'modern', location));
    const secondMerge = f.human.createMerge(f.bob.id, f.workspace.mainBranchId, [replacement.id], 1, 1);
    assert.ok(secondMerge.reviewId);
    assert.deepEqual(f.human.review(secondMerge.reviewId!).conflicts, [{
      key: 'runtime', existingCommitId: original.id, incomingCommitId: replacement.id,
    }]);
    f.human.resolveReview(secondMerge.reviewId!, 'approved');
    f.human.applyMerge(secondMerge.id);
    const current = f.human.snapshot(f.workspace.mainBranchId);
    assert.deepEqual(current.history.map(c => c.id), [original.id, replacement.id]);
    assert.equal(current.knowledge.find(c => c.knowledge.key === 'runtime')?.id, replacement.id);
    assert.equal(f.bobAgent.snapshot(f.bob.id, beforeReplacement.revision).knowledge.find(c => c.knowledge.key === 'runtime')?.id, original.id);

    f.store.close();
    const restarted = new SqliteStore(f.path);
    try {
      const human = new AgentreeService(restarted, { type: 'human', id: 'human-reviewer' });
      assert.deepEqual(human.snapshot(f.workspace.mainBranchId, pinnedMain.revision).history.map(c => c.id), [original.id]);
      assert.deepEqual(human.snapshot(f.workspace.mainBranchId).history.map(c => c.id), [original.id, replacement.id]);
      const carol = human.createBranch(f.workspace.id, 'carol');
      assert.deepEqual(human.snapshot(carol.id).history.map(c => c.id), [original.id, replacement.id]);
      assert.equal(human.snapshot(carol.id).knowledge.find(c => c.knowledge.key === 'runtime')?.id, replacement.id);
    } finally { restarted.close(); }
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('an inherited main advance invalidates pending and approved merges into a restricted branch', () => {
  const f = fixture();
  let secondStore: SqliteStore | undefined;
  try {
    const target = f.human.createBranch(f.workspace.id, 'restricted-target', true);
    const pendingCommit = f.aliceAgent.publish(f.alice.id, finding('pending', 'pending proposal'));
    const approvedCommit = f.aliceAgent.publish(f.alice.id, finding('approved', 'approved proposal'));
    const pending = f.human.createMerge(f.alice.id, target.id, [pendingCommit.id], 0, 0);
    const approved = f.human.createMerge(f.alice.id, target.id, [approvedCommit.id], 0, 0);
    assert.ok(pending.reviewId && approved.reviewId);
    f.human.resolveReview(approved.reviewId, 'approved');
    const targetRevision = f.store.get<{ revision: number }>(target.id)!.revision;

    secondStore = new SqliteStore(f.path);
    const secondHuman = new AgentreeService(secondStore, { type: 'human', id: 'second-connection' });
    const mainCommit = f.bobAgent.publish(f.bob.id, finding('main-update', 'advance shared main'));
    const mainMerge = secondHuman.createMerge(f.bob.id, f.workspace.mainBranchId, [mainCommit.id], 0, 0);
    secondHuman.resolveReview(mainMerge.reviewId!, 'approved');
    secondHuman.applyMerge(mainMerge.id);

    assert.equal(f.store.get<{ revision: number }>(target.id)!.revision, targetRevision);
    assert.throws(() => f.human.resolveReview(pending.reviewId!, 'approved'), errCode('STALE'));
    assert.throws(() => f.human.applyMerge(pending.id), errCode('STALE'));
    assert.throws(() => f.human.applyMerge(approved.id), errCode('STALE'));
    assert.deepEqual(f.human.context(target.id).map(c => c.id), [mainCommit.id]);
    assert.equal(f.human.context(target.id).some(c => c.id === pendingCommit.id || c.id === approvedCommit.id), false);
  } finally {
    secondStore?.close();
    f.store.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test('decision conflicts use overlapping impact scopes, preserve disjoint-root decisions, and reject overlapping incoming batches', () => {
  const f = fixture([{ id: 'src', path: '/repo/src' }, { id: 'docs', path: '/repo/docs' }]);
  try {
    const targetSession = f.human.registerSession(f.bob.id, { id: 'agent-bob', name: 'Bob' }, 'claude', 'native-bob');
    const target = new AgentreeService(f.store, { type: 'agent', sessionId: targetSession.id });
    const srcFile = { type: 'file' as const, rootId: 'src', path: 'api.ts' };
    const docsFile = { type: 'file' as const, rootId: 'docs', path: 'api.ts' };
    const broadImpact = { type: 'folder' as const, rootId: 'src', path: '.' };
    const existing = target.publish(f.bob.id, decision('serializer', 'v1', srcFile, broadImpact));
    const disjoint = f.aliceAgent.publish(f.alice.id, decision('serializer', 'docs variant', docsFile));
    const disjointMerge = f.human.createMerge(f.alice.id, f.bob.id, [disjoint.id], 1, 0);
    assert.equal(disjointMerge.reviewId, undefined);
    f.human.applyMerge(disjointMerge.id);

    const overlap = f.aliceAgent.publish(f.alice.id, decision('serializer', 'v2', srcFile));
    const conflictMerge = f.human.createMerge(f.alice.id, f.bob.id, [overlap.id], 2, 0);
    assert.ok(conflictMerge.reviewId);
    assert.deepEqual(f.human.review(conflictMerge.reviewId!).conflicts, [{ key: 'serializer', existingCommitId: existing.id, incomingCommitId: overlap.id }]);
    f.human.resolveReview(conflictMerge.reviewId!, 'approved');
    f.human.applyMerge(conflictMerge.id);

    const overlapOne = f.aliceAgent.publish(f.alice.id, decision('build', 'one', { type: 'folder', rootId: 'src', path: 'lib' }));
    const overlapTwo = f.aliceAgent.publish(f.alice.id, decision('build', 'two', { type: 'file', rootId: 'src', path: 'lib/tool.ts' }));
    assert.throws(() => f.human.createMerge(f.alice.id, f.bob.id, [overlapOne.id, overlapTwo.id], 3, 0), errCode('MERGE'));
  } finally { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('event pages have stable high-water cursors, filters, deduplication, monotonic sequences and authorization', () => {
  const f = fixture();
  try {
    const first = event(f.workspace.id, f.aliceSession.id, 'native-1');
    const second = event(f.workspace.id, f.aliceSession.id, 'native-2', 'tool');
    const third = event(f.workspace.id, f.bobSession.id, 'native-3');
    assert.equal(f.aliceAgent.ingest(first), true);
    assert.equal(f.aliceAgent.ingest({ ...first, id: 'duplicate-id' }), false);
    assert.equal(f.aliceAgent.ingest(second), true);
    assert.equal(f.bobAgent.ingest(third), true);

    const firstPage = f.human.events(f.workspace.id, { limit: 1, source: 'runtime-a' });
    assert.equal(firstPage.events.length, 1);
    assert.equal(firstPage.hasMore, true);
    assert.ok(firstPage.events[0].sequence > 0);
    const appended = event(f.workspace.id, f.aliceSession.id, 'native-4');
    f.aliceAgent.ingest(appended);
    const secondPage = f.human.events(f.workspace.id, { afterSequence: firstPage.nextSequence, throughSequence: firstPage.throughSequence, limit: 10, source: 'runtime-a' });
    assert.equal(secondPage.throughSequence, firstPage.throughSequence);
    assert.equal(secondPage.events.some(e => e.id === appended.id), false);
    assert.ok(secondPage.events.every(e => e.sequence > firstPage.events[0].sequence && e.sequence <= firstPage.throughSequence));
    const idle = f.human.events(f.workspace.id, { afterSequence: secondPage.throughSequence, throughSequence: secondPage.throughSequence });
    assert.deepEqual(idle.events, []);
    assert.equal(idle.nextSequence, secondPage.throughSequence);
    assert.equal(idle.throughSequence, secondPage.throughSequence);
    const filtered = f.human.events(f.workspace.id, { sessionId: f.bobSession.id, type: 'message' });
    assert.deepEqual(filtered.events.map(e => e.id), [third.id]);

    const all = f.human.events(f.workspace.id, { limit: 1000 });
    assert.deepEqual(all.events.map(e => e.sequence), [...all.events.map(e => e.sequence)].sort((a, b) => a - b));
    assert.equal(new Set(all.events.map(e => e.sequence)).size, all.events.length);
    assert.equal(all.events.filter(e => e.id === first.id).length, 1);
    let drained = f.human.events(f.workspace.id, { limit: 2 });
    while (drained.hasMore) {
      drained = f.human.events(f.workspace.id, { afterSequence: drained.nextSequence, throughSequence: drained.throughSequence, limit: 2 });
    }
    const liveCursor = drained.nextSequence;
    for (let i = 0; i < 3; i++) {
      const idleLive = f.human.events(f.workspace.id, { afterSequence: liveCursor });
      assert.deepEqual(idleLive.events, []);
      assert.equal(idleLive.nextSequence, liveCursor);
      assert.equal(idleLive.throughSequence, liveCursor);
      assert.equal(idleLive.hasMore, false);
    }
    const lastBeforeClose = all.events.at(-1)!.sequence;
    f.store.close();
    const restarted = new SqliteStore(f.path);
    try {
      const human = new AgentreeService(restarted, { type: 'human', id: 'human-reviewer' });
      const next = event(f.workspace.id, f.aliceSession.id, 'native-after-restart');
      const alice = new AgentreeService(restarted, { type: 'agent', sessionId: f.aliceSession.id });
      assert.equal(alice.ingest(next), true);
      const pages = human.events(f.workspace.id, { afterSequence: lastBeforeClose });
      assert.ok(pages.events.every(e => e.sequence > lastBeforeClose));
      assert.ok(pages.events.some(e => e.id === next.id));
      assert.throws(() => human.events(f.workspace.id, { afterSequence: -1 }), errCode('CURSOR'));
      assert.throws(() => human.events(f.workspace.id, { throughSequence: 0, afterSequence: 1 }), errCode('CURSOR'));
      assert.throws(() => human.events(f.workspace.id, { limit: 1001 }), errCode('CURSOR'));

      const other = human.createWorkspace('other');
      assert.throws(() => alice.events(other.id), errCode('DENY'));
    } finally { restarted.close(); }
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
