import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteStore } from '../../storage/src/index.js';
import { AgentreeService } from './index.js';
import { DomainError, type Knowledge, type Scope } from '../../contracts/src/index.js';

function fixture() {
  const store = new SqliteStore(':memory:');
  const human = new AgentreeService(store,{type:'human',id:'reviewer'});
  const workspace = human.createWorkspace('resolution');
  const source = human.createBranch(workspace.id,'source');
  const target = human.createBranch(workspace.id,'target');
  function author(branchId: string) {
    const s = human.registerSession(branchId,{id:`agent-${branchId}`,name:'author'},'test',branchId);
    return new AgentreeService(store,{type:'agent',sessionId:s.id});
  }
  return {store,human,workspace,source,target,sourceAuthor:author(source.id),targetAuthor:author(target.id)};
}
const decision = (body: string, scope: Scope, impactScope?: Scope): Knowledge => ({kind:'decision',key:'choice',body,scope,impactScope});
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
const file = (path: string): Scope => ({type:'file',path});

test('a review cannot retain and supersede the same broad decision in one batch', () => {
  const f = fixture();
  try {
    const old = f.targetAuthor.publish(f.target.id,decision('old',{type:'workspace'}));
    const before = f.human.snapshot(f.target.id);
    const a = f.sourceAuthor.publish(f.source.id,decision('A',file('a.ts')));
    const b = f.sourceAuthor.publish(f.source.id,decision('B',file('b.ts')));
    const merge = f.human.createMerge(f.source.id,f.target.id,[a.id,b.id],1);
    const conflicts = f.human.review(merge.reviewId!).conflicts;
    assert.equal(conflicts.length,2);
    assert.throws(() => f.human.resolveReview(merge.reviewId!,'approved',conflicts.map((c,i) => ({...c,selectedCommitId:i === 0 ? old.id : c.incomingCommitId}))),code('RESOLUTION'));
    assert.equal(f.human.review(merge.reviewId!).state,'pending');
    f.human.resolveReview(merge.reviewId!,'approved');
    f.human.applyMerge(merge.id);
    assert.deepEqual(f.human.lookup(f.target.id).map(c => c.id).sort(),[a.id,b.id].sort());
    assert.deepEqual(f.human.snapshot(f.target.id,before.revision).knowledge.map(c => c.id),[old.id]);
    assert.deepEqual(f.human.context(f.target.id).map(c => c.id),[old.id,a.id,b.id]);
  } finally { f.store.close(); }
});

test('a broad incoming decision must receive consistent choices for all overlapping existing decisions', () => {
  const f = fixture();
  try {
    const a = f.targetAuthor.publish(f.target.id,decision('A',file('a.ts')));
    const b = f.targetAuthor.publish(f.target.id,decision('B',file('b.ts')));
    const incoming = f.sourceAuthor.publish(f.source.id,decision('broad',{type:'workspace'}));
    const merge = f.human.createMerge(f.source.id,f.target.id,[incoming.id],2);
    const conflicts = f.human.review(merge.reviewId!).conflicts;
    assert.throws(() => f.human.resolveReview(merge.reviewId!,'approved',conflicts.map((c,i) => ({...c,selectedCommitId:i === 0 ? c.existingCommitId : incoming.id}))),code('RESOLUTION'));
    assert.throws(() => f.human.resolveReview(merge.reviewId!,'approved',[]),code('RESOLUTION'));
    f.human.resolveReview(merge.reviewId!,'approved',conflicts.map(c => ({...c,selectedCommitId:c.existingCommitId})));
    f.human.applyMerge(merge.id);
    assert.deepEqual(f.human.lookup(f.target.id).map(c => c.id).sort(),[a.id,b.id].sort());
    assert.ok(f.human.context(f.target.id).some(c => c.id === incoming.id));
  } finally { f.store.close(); }
});

test('equivalent decisions at overlapping locations preserve the wider accepted scope', () => {
  const f = fixture();
  try {
    const broad = f.targetAuthor.publish(f.target.id,decision('same',{type:'workspace'}));
    const narrow = f.sourceAuthor.publish(f.source.id,decision('same',file('a.ts')));
    const merge = f.human.createMerge(f.source.id,f.target.id,[narrow.id],1);
    assert.equal(merge.reviewId,undefined);
    f.human.applyMerge(merge.id);
    assert.deepEqual(f.human.lookup(f.target.id).map(c => c.id).sort(),[broad.id,narrow.id].sort());
  } finally { f.store.close(); }
});

test('same decision identity conflicts even when the declared impact scopes are disjoint', () => {
  const f = fixture();
  try {
    const old = f.targetAuthor.publish(f.target.id,decision('old',file('config.ts'),file('a.ts')));
    const incoming = f.sourceAuthor.publish(f.source.id,decision('new',file('config.ts'),file('b.ts')));
    const merge = f.human.createMerge(f.source.id,f.target.id,[incoming.id],1);
    assert.deepEqual(f.human.review(merge.reviewId!).conflicts,[{key:'choice',existingCommitId:old.id,incomingCommitId:incoming.id}]);
    f.human.resolveReview(merge.reviewId!,'approved');
    f.human.applyMerge(merge.id);
    assert.deepEqual(f.human.lookup(f.target.id).map(c => c.id),[incoming.id]);
  } finally { f.store.close(); }
});

test('entity kinds are validated at the application boundary without reference-check triggers', () => {
  const f = fixture();
  try {
    assert.throws(() => f.human.createBranch(f.source.id,'wrong-workspace'),code('NOT_FOUND'));
    assert.throws(() => f.human.registerSession(f.workspace.id,{id:'a',name:'A'},'test','bad-branch'),code('NOT_FOUND'));
    assert.throws(() => f.human.context(f.workspace.id),code('NOT_FOUND'));
    const invalidSession = new AgentreeService(f.store,{type:'agent',sessionId:f.source.id});
    assert.throws(() => invalidSession.context(f.source.id),code('NOT_FOUND'));
  } finally { f.store.close(); }
});
