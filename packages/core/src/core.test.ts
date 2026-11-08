import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentreeService } from './index.js';
import { DomainError, type FileRef, type WorkInput } from '../../contracts/src/index.js';
import { SqliteStore } from '../../storage/src/index.js';

function fixture() {
  const store = new SqliteStore(':memory:');
  const human = new AgentreeService(store, { type: 'human', id: 'human' });
  const workspace = human.createWorkspace('test', [{ id: 'repo', path: '/tmp/repo' }]);
  const alice = human.createBranch(workspace.id, 'alice');
  const bob = human.createBranch(workspace.id, 'bob');
  const other = human.createWorkspace('other');
  const aSession = human.registerSession(alice.id, { id: 'a', name: 'Alice' }, 'codex', 'a-native');
  const bSession = human.registerSession(bob.id, { id: 'b', name: 'Bob' }, 'claude', 'b-native');
  return { store, human, workspace, alice, bob, other,
    a: new AgentreeService(store, { type: 'agent', sessionId: aSession.id }),
    b: new AgentreeService(store, { type: 'agent', sessionId: bSession.id }) };
}
const file = (path: string): FileRef => ({ rootId: 'repo', path });
const code = (wanted: string) => (error: unknown) => error instanceof DomainError && error.code === wanted;
const work = (body: string, files: FileRef[] = []): WorkInput => ({ body, files });

test('agents are confined to their workspace and own branch; Main is human-only', () => {
  const f = fixture();
  try {
    assert.throws(() => f.a.proposeWork(f.bob.id, work('wrong branch')), code('DENY'));
    assert.throws(() => f.a.main(f.other.id), code('DENY'));
    assert.throws(() => f.a.editMain(f.workspace.id, { body: 'agent edit' }, 0), code('DENY'));
    assert.equal(f.human.main(f.workspace.id).revision, 0);
  } finally { f.store.close(); }
});

test('Main entries are revised, removable, restored in history, and reject stale writers', () => {
  const f = fixture();
  try {
    const first = f.human.editMain(f.workspace.id, { body: 'Use the stable API', files: [file('src/api.ts')] }, 0);
    const edited = f.human.editMain(f.workspace.id, { body: 'Use API v2', files: [file('src/api.ts')] }, 1, first.id);
    assert.equal(edited.id, first.id);
    assert.throws(() => f.human.editMain(f.workspace.id, { body: 'stale' }, 1, first.id), code('STALE'));
    const removed = f.human.editMain(f.workspace.id, { body: 'Use API v2' }, 2, first.id, true);
    assert.equal(removed.removed, true);
    assert.deepEqual(f.human.main(f.workspace.id).entries, []);
    assert.deepEqual(f.human.mainHistory(f.workspace.id, first.id).map(e => [e.revision, e.removed]), [[1, false], [2, false], [3, true]]);
  } finally { f.store.close(); }
});

test('overlapping declared files create potential conflict and human decides it', () => {
  const f = fixture();
  try {
    const a = f.a.proposeWork(f.alice.id, work('Change parser', [file('src/parser.ts')]));
    const b = f.b.proposeWork(f.bob.id, work('Replace parser', [file('src/parser.ts')]));
    const potential = f.human.conflicts(f.workspace.id).find(c => c.branchIds.includes(f.alice.id) && c.branchIds.includes(f.bob.id));
    assert.ok(potential, 'file overlap is surfaced');
    assert.equal(potential.status, 'potential');
    const decided = f.human.decideConflict(f.workspace.id, potential.id, 'confirmed', 'Both proposals alter the parser contract');
    assert.equal(decided.status, 'confirmed');
    assert.equal(f.human.conflicts(f.workspace.id).find(c => c.id === potential.id)?.explanation, 'Both proposals alter the parser contract');
    assert.ok(a.id && b.id);
  } finally { f.store.close(); }
});

test('rooted native file observations create potential overlap without treating interception as confirmation', () => {
  const f = fixture();
  try {
    const sessionA = f.store.list<{id:string;branchId:string}>('session').find(s => s.branchId === f.alice.id)!;
    const sessionB = f.store.list<{id:string;branchId:string}>('session').find(s => s.branchId === f.bob.id)!;
    const event = (id:string, sessionId:string, nativeId:string) => ({ id, workspaceId:f.workspace.id, source:'native', nativeId,
      sessionId, type:'file.changed', mode:'observed' as const,
      payload:{touches:[{rootId:'repo',path:'src/native.ts',access:'write'}]}, occurredAt:new Date().toISOString() });
    const eventA=event('observed-a',sessionA.id,'native-a');
    const eventB=event('observed-b',sessionB.id,'native-b');
    assert.equal(f.a.ingest(eventA),true);
    assert.equal(f.b.ingest(eventB),true);
    const overlap=f.human.conflicts(f.workspace.id).find(c=>c.branchIds.includes(f.alice.id)&&c.branchIds.includes(f.bob.id));
    assert.ok(overlap);
    assert.equal(overlap.status,'potential');
    assert.ok(overlap.evidenceIds.includes(eventA.id)&&overlap.evidenceIds.includes(eventB.id));
    assert.equal(f.human.decideConflict(f.workspace.id,overlap.id,'confirmed','Human reviewed the overlap').status,'confirmed');
    assert.throws(()=>f.a.ingest({...eventA,id:'controlled',nativeId:'native-controlled',mode:'controlled'}),code('EVENT'));
  } finally { f.store.close(); }
});

test('work may explicitly cite incompatible Main entry; a human may report other conflicts', () => {
  const f = fixture();
  try {
    const entry = f.human.editMain(f.workspace.id, { body: 'Keep protocol v1' }, 0);
    const proposal = f.a.proposeWork(f.alice.id, { ...work('Move to protocol v2'), conflictsWithMain: [entry.id] });
    const conflict = f.human.conflicts(f.workspace.id).find(c => c.mainEntryId === entry.id && c.branchIds.includes(f.alice.id));
    assert.ok(conflict);
    assert.ok(conflict.evidenceIds.includes(proposal.id));
    assert.equal(conflict.status, 'potential');
    const reported = f.human.reportConflict(f.workspace.id, { branchIds: [f.alice.id], mainEntryId: entry.id, explanation: 'Human identified incompatibility' });
    assert.equal(reported.explanation, 'Human identified incompatibility');
  } finally { f.store.close(); }
});

test('overlapping Main and branch file references are potential; matching prose alone is not evidence', () => {
  const f=fixture();
  try {
    const entry=f.human.editMain(f.workspace.id,{body:'Use the stable interface',files:[file('src/interface.ts')]},0);
    f.a.proposeWork(f.alice.id,{body:'Use the stable interface',files:[]});
    assert.equal(f.human.conflicts(f.workspace.id).some(c=>c.mainEntryId===entry.id),false);
    f.b.proposeWork(f.bob.id,work('Update interface', [file('src/interface.ts')]));
    assert.ok(f.human.conflicts(f.workspace.id).some(c=>c.mainEntryId===entry.id&&c.branchIds.includes(f.bob.id)));
  } finally { f.store.close(); }
});

test('acceptance is human-only, optimistic and atomic; rejection does not alter Main', () => {
  const f = fixture();
  try {
    const first = f.a.proposeWork(f.alice.id, work('Accepted text', [file('src/a.ts')]));
    const second = f.a.proposeWork(f.alice.id, work('Rejected text'));
    assert.throws(() => f.a.decideMerge(f.alice.id, [first.id], 'accepted', 0), code('DENY'));
    const accepted = f.human.decideMerge(f.alice.id, [first.id], 'accepted', 0);
    assert.equal(accepted.state, 'accepted');
    assert.equal(f.human.main(f.workspace.id).revision, 1);
    assert.equal(f.human.main(f.workspace.id).entries[0]?.body, 'Accepted text');
    assert.equal(f.human.main(f.workspace.id).entries[0]?.sourceWorkId, first.id);
    assert.throws(() => f.human.decideMerge(f.alice.id, [second.id], 'accepted', 0), code('STALE'));
    assert.throws(() => f.human.decideMerge(f.alice.id, ['missing'], 'accepted', 1), code('NOT_FOUND'));
    assert.equal(f.human.main(f.workspace.id).entries.length, 1);
    const rejected = f.human.decideMerge(f.alice.id, [second.id], 'rejected', 1);
    assert.equal(rejected.state, 'rejected');
    assert.equal(f.human.main(f.workspace.id).revision, 1);
    assert.equal(f.human.merges(f.workspace.id).length, 2);
  } finally { f.store.close(); }
});

test('corrections are durable human messages scoped to their branch', () => {
  const f = fixture();
  try {
    const correction = f.human.sendCorrection(f.alice.id, 'Please check the API note in Main');
    assert.equal(correction.body, 'Please check the API note in Main');
    assert.equal(correction.branchId, f.alice.id);
    assert.equal(f.a.branchOverview(f.alice.id).corrections[0]?.id, correction.id);
    assert.throws(()=>f.a.sendCorrection(f.alice.id,'agent message'),code('DENY'));
  } finally { f.store.close(); }
});

test('potential conflicts can be dismissed or resolved by human disposition', () => {
  const f = fixture();
  try {
    f.a.proposeWork(f.alice.id, work('a', [file('src/shared.ts')]));
    f.b.proposeWork(f.bob.id, work('b', [file('src/shared.ts')]));
    const conflict = f.human.conflicts(f.workspace.id)[0]!;
    assert.equal(f.human.decideConflict(f.workspace.id, conflict.id, 'dismissed', 'The paths overlap but the edits do not conflict').status, 'dismissed');
  } finally { f.store.close(); }
});

test('observed native events remain deduplicated evidence, distinct from intercepted controlled actions', () => {
  const f = fixture();
  try {
    const branches = f.human.branches(f.workspace.id);
    assert.ok(branches.some(b => b.id === f.alice.id));
    const session = f.store.list<{ id: string; branchId: string }>('session').find(s => s.branchId === f.alice.id)!;
    const event = { id: 'evt-1', workspaceId: f.workspace.id, source: 'codex', nativeId: 'native-event-1', sessionId: session.id,
      type: 'file.changed', mode: 'observed' as const, payload: { touches: [{ rootId:'repo', path:'src/native.ts', access:'write' }] }, occurredAt: new Date().toISOString() };
    assert.equal(f.a.ingest(event), true);
    assert.equal(f.a.ingest({ ...event, id: 'evt-retry' }), false);
    assert.equal(f.human.events(f.workspace.id).events.some(e => e.id === event.id), true);
    assert.throws(() => f.a.ingest({ ...event, id: 'evt-controlled', nativeId: 'native-controlled', mode: 'controlled' }), code('EVENT'));
    assert.throws(() => f.a.ingest({ ...event, id:'evt-foreign', workspaceId:f.other.id, nativeId:'native-foreign' }), code('DENY'));
  } finally { f.store.close(); }
});

test('invalid file roots and traversal are rejected; failed batch acceptance changes nothing',()=>{
  const f=fixture();
  try {
    assert.throws(()=>f.a.proposeWork(f.alice.id,work('unknown root',[{rootId:'missing',path:'src/a.ts'}])));
    assert.throws(()=>f.a.proposeWork(f.alice.id,work('escape',[file('../secret')])));
    const good=f.a.proposeWork(f.alice.id,work('valid'));
    const before=f.human.main(f.workspace.id);
    assert.throws(()=>f.human.decideMerge(f.alice.id,[good.id,'missing'],'accepted',before.revision),code('NOT_FOUND'));
    assert.equal(f.human.main(f.workspace.id).revision,before.revision);
    assert.equal(f.store.get<{state:string}>(good.id,'branch-work')?.state,'proposed');
  } finally { f.store.close(); }
});
