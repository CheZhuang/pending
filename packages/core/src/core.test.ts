import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentreeService } from './index.js';
import { DomainError, type NormalizedEvent } from '../../contracts/src/index.js';
import { SqliteStore } from '../../storage/src/index.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'agentree-core-'));
  const path = join(directory, 'agentree.sqlite');
  const store = new SqliteStore(path);
  const human = new AgentreeService(store, { type: 'human', id: 'reviewer' });
  const workspace = human.createWorkspace('test');
  const source = human.createBranch(workspace.id, 'source');
  const sourceB = human.createBranch(workspace.id, 'source-b');
  const target = human.createBranch(workspace.id, 'restricted', true);
  const firstSession = human.registerSession(source.id, { id: 'agent-a', name: 'A' }, 'codex', 'native-a');
  const secondSession = human.registerSession(sourceB.id, { id: 'agent-b', name: 'B' }, 'claude', 'native-b');
  return { directory, path, store, human, workspace, source, sourceB, target, firstSession, secondSession };
}

const finding = (body: string) => ({ kind: 'finding' as const, key: 'shared-fact', body, scope: { type: 'workspace' as const } });
const decision = (body: string) => ({ kind: 'decision' as const, key: 'api-choice', body, scope: { type: 'workspace' as const } });
const eventFor = (sessionId: string, nativeId: string): NormalizedEvent => ({
  id: `event-${nativeId}`, workspaceId: 'workspace-placeholder', source: 'codex', nativeId,
  sessionId, type: 'message', mode: 'observed', payload: {}, occurredAt: new Date().toISOString(),
});

test('two sessions publish, restricted merge requires review, and review/audit survive restart', () => {
  const f = fixture();
  try {
    const agentA = new AgentreeService(f.store, { type: 'agent', sessionId: f.firstSession.id });
    const agentB = new AgentreeService(f.store, { type: 'agent', sessionId: f.secondSession.id });
    const eventA = { ...eventFor(f.firstSession.id, 'native-event-a'), workspaceId: f.workspace.id };
    const eventB = { ...eventFor(f.secondSession.id, 'native-event-b'), workspaceId: f.workspace.id };
    assert.equal(agentA.ingest(eventA), true);
    assert.equal(agentB.ingest(eventB), true);
    assert.equal(agentA.ingest({ ...eventA, id: 'duplicate-event-id' }), false);
    const a = agentA.publish(f.source.id, finding('from A'), [eventA.id]);
    const b = agentB.publish(f.sourceB.id, finding('from B'), [eventB.id]);
    const mergeA = f.human.createMerge(f.source.id, f.target.id, [a.id], 0);
    assert.ok(mergeA.reviewId);
    assert.throws(() => f.human.applyMerge(mergeA.id), (error) => error instanceof DomainError && error.code === 'REVIEW');
    assert.equal(f.human.resolveReview(mergeA.reviewId!, 'approved').state, 'approved');
    assert.equal(f.human.applyMerge(mergeA.id).state, 'applied');
    const mergeB = f.human.createMerge(f.sourceB.id, f.target.id, [b.id], 1);
    assert.ok(mergeB.reviewId);
    f.human.resolveReview(mergeB.reviewId!, 'approved');
    assert.equal(f.human.applyMerge(mergeB.id).state, 'applied');
    f.store.close();

    const restarted = new SqliteStore(f.path);
    try {
      const service = new AgentreeService(restarted, { type: 'human', id: 'reviewer' });
      assert.deepEqual(service.context(f.target.id).map((commit) => commit.id), [a.id, b.id]);
      assert.equal(service.review(mergeA.reviewId!).state, 'resolved');
      assert.equal(service.review(mergeB.reviewId!).state, 'resolved');
      assert.ok(restarted.events<{ type?: string }>().some((event) => event.type === 'review.decided'));
      assert.ok(restarted.events<{ type?: string }>().some((event) => event.type === 'merge.applied'));
    } finally { restarted.close(); }
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('stale merge review cannot be applied after target revision changes', () => {
  const f = fixture();
  try {
    const author = new AgentreeService(f.store, { type: 'agent', sessionId: f.firstSession.id });
    const sourceCommit = author.publish(f.source.id, finding('incoming'));
    const merge = f.human.createMerge(f.source.id, f.target.id, [sourceCommit.id], 0);
    assert.ok(merge.reviewId);
    f.human.resolveReview(merge.reviewId!, 'approved');
    f.store.insert('target-session-agent', 'agent', { id: 'target-agent', name: 'Target' });
    const targetSession = f.human.registerSession(f.target.id, { id: 'target-agent', name: 'Target' }, 'codex', 'target-native');
    new AgentreeService(f.store, { type: 'agent', sessionId: targetSession.id }).publish(f.target.id, finding('target update'));
    assert.throws(() => f.human.applyMerge(merge.id), (error) => error instanceof DomainError && error.code === 'STALE');
  } finally { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('rejected review prevents merge application', () => {
  const f = fixture();
  try {
    const author = new AgentreeService(f.store, { type: 'agent', sessionId: f.firstSession.id });
    const commit = author.publish(f.source.id, finding('reject this'));
    const merge = f.human.createMerge(f.source.id, f.target.id, [commit.id], 0);
    assert.ok(merge.reviewId);
    assert.equal(f.human.resolveReview(merge.reviewId!, 'rejected').state, 'rejected');
    assert.equal(f.store.get<typeof merge>(merge.id)?.state, 'rejected');
    assert.throws(() => f.human.applyMerge(merge.id), (error) => error instanceof DomainError && error.code === 'STATE');
    assert.deepEqual(f.human.context(f.target.id), []);
  } finally { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('agents cannot publish to another branch or read another workspace', () => {
  const f = fixture();
  try {
    const agent = new AgentreeService(f.store, { type: 'agent', sessionId: f.firstSession.id });
    assert.throws(() => agent.publish(f.sourceB.id, finding('unauthorized')), (error) => error instanceof DomainError && error.code === 'DENY');
    const otherWorkspace = f.human.createWorkspace('other');
    assert.throws(() => agent.workspace(otherWorkspace.id), (error) => error instanceof DomainError && error.code === 'DENY');
    const foreignBranch = f.human.createBranch(otherWorkspace.id, 'foreign');
    assert.throws(() => agent.context(foreignBranch.id), (error) => error instanceof DomainError && error.code === 'DENY');
  } finally { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('competing merges use optimistic revision checks, including after approval', () => {
  const f = fixture();
  try {
    const author = new AgentreeService(f.store, { type: 'agent', sessionId: f.firstSession.id });
    const one = author.publish(f.source.id, finding('first'));
    const two = author.publish(f.source.id, finding('second'));
    const first = f.human.createMerge(f.source.id, f.target.id, [one.id], 0);
    const second = f.human.createMerge(f.source.id, f.target.id, [two.id], 0);
    assert.ok(first.reviewId && second.reviewId);
    f.human.resolveReview(first.reviewId, 'approved');
    f.human.resolveReview(second.reviewId, 'approved');
    f.human.applyMerge(first.id);
    assert.throws(() => f.human.applyMerge(second.id), (error) => error instanceof DomainError && error.code === 'STALE');
    assert.deepEqual(f.human.context(f.target.id).map((commit) => commit.id), [one.id]);
  } finally { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('failed second attachment rolls back the entire merge', () => {
  const f = fixture();
  try {
    const author = new AgentreeService(f.store, { type: 'agent', sessionId: f.firstSession.id });
    const first = author.publish(f.source.id, finding('first attach'));
    const second = author.publish(f.source.id, finding('fails after first'));
    const merge = f.human.createMerge(f.source.id, f.target.id, [first.id, second.id], 0);
    assert.ok(merge.reviewId);
    f.human.resolveReview(merge.reviewId, 'approved');
    f.store.db.exec(`CREATE TRIGGER fail_second_attach BEFORE INSERT ON branch_commits
      WHEN NEW.commit_id = '${second.id}' BEGIN SELECT RAISE(ABORT, 'injected attach failure'); END`);
    assert.throws(() => f.human.applyMerge(merge.id), /injected attach failure/);
    assert.deepEqual(f.human.context(f.target.id), []);
    assert.equal(f.store.get<typeof merge>(merge.id)?.state, 'pending');
    assert.equal(f.human.review(merge.reviewId).state, 'approved');
  } finally { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('conflicting decision import requires human review and lookup returns replacement', () => {
  const f = fixture();
  try {
    const sourceAuthor = new AgentreeService(f.store, { type: 'agent', sessionId: f.firstSession.id });
    const targetSession = f.human.registerSession(f.target.id, { id: 'target-agent', name: 'Target' }, 'codex', 'target-native');
    const targetAuthor = new AgentreeService(f.store, { type: 'agent', sessionId: targetSession.id });
    const oldDecision = targetAuthor.publish(f.target.id, decision('Use option alpha'));
    const replacement = sourceAuthor.publish(f.source.id, decision('Use option beta'));
    const merge = f.human.createMerge(f.source.id, f.target.id, [replacement.id], 1);
    assert.ok(merge.reviewId);
    assert.deepEqual(f.human.review(merge.reviewId).conflicts, [{
      key: 'api-choice', existingCommitId: oldDecision.id, incomingCommitId: replacement.id,
    }]);
    assert.throws(() => f.human.applyMerge(merge.id), (error) => error instanceof DomainError && error.code === 'REVIEW');
    f.human.resolveReview(merge.reviewId, 'approved');
    f.human.applyMerge(merge.id);
    const effective = f.human.lookup(f.target.id).filter((commit) => commit.knowledge.kind === 'decision');
    assert.equal(effective.length, 1);
    assert.equal(effective[0].id, replacement.id);
  } finally { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('authorization denial occurs before controlled callback executes', () => {
  const f = fixture();
  try {
    const agent = new AgentreeService(f.store, { type: 'agent', sessionId: f.firstSession.id });
    let called = false;
    assert.throws(() => agent.executeControlled(f.source.id, () => { called = true; }), (error) => error instanceof DomainError && error.code === 'REQUIRE-APPROVAL');
    assert.equal(called, false);
    assert.ok(f.store.events<{ type?: string }>().some((event) => event.type === 'policy.decision'));
    let humanCalled = false;
    assert.equal(f.human.executeControlled(f.source.id, () => { humanCalled = true; return 42; }), 42);
    assert.equal(humanCalled, true);
    const other = f.human.createWorkspace('outside');
    const foreignBranch = f.human.createBranch(other.id, 'outside');
    let deniedCalled = false;
    assert.throws(() => agent.executeControlled(foreignBranch.id, () => { deniedCalled = true; }), (error) => error instanceof DomainError && error.code === 'DENY');
    assert.equal(deniedCalled, false);
  } finally { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('transaction rolls back and SQLite guards immutable commits and events', () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.transaction(() => {
      f.store.insert('rolled-back', 'finding', { value: true });
      throw new Error('abort');
    }), /abort/);
    assert.equal(f.store.get('rolled-back'), undefined);
    const author = new AgentreeService(f.store, { type: 'agent', sessionId: f.firstSession.id });
    const commit = author.publish(f.source.id, finding('immutable'));
    const event = { ...eventFor(f.firstSession.id, 'immutable-native'), workspaceId: f.workspace.id };
    author.ingest(event);
    assert.throws(() => f.store.db.prepare('UPDATE entities SET data = ? WHERE id = ?').run('{}', commit.id));
    assert.throws(() => f.store.db.prepare('DELETE FROM entities WHERE id = ?').run(commit.id));
    assert.throws(() => f.store.db.prepare('UPDATE events SET data = ? WHERE id = ?').run('{}', event.id));
    assert.throws(() => f.store.db.prepare('DELETE FROM events WHERE id = ?').run(event.id));
  } finally { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); }
});
