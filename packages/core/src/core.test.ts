import assert from 'node:assert/strict';
import test from 'node:test';
import { PendingTreeService } from './index.js';
import { DomainError, type FileRef, type WorkInput } from '../../contracts/src/index.js';
import { SqliteStore } from '../../storage/src/index.js';

function fixture() {
  const store = new SqliteStore(':memory:');
  const human = new PendingTreeService(store, { type: 'human', id: 'human' });
  const workspace = human.createWorkspace('test', [{ id: 'repo', path: '/tmp/repo' }]);
  const alice = human.createBranch(workspace.id, 'alice');
  const bob = human.createBranch(workspace.id, 'bob');
  const other = human.createWorkspace('other');
  const aSession = human.registerSession(alice.id, { id: 'a', name: 'Alice' }, 'codex', 'a-native');
  const bSession = human.registerSession(bob.id, { id: 'b', name: 'Bob' }, 'claude', 'b-native');
  return { store, human, workspace, alice, bob, other,
    a: new PendingTreeService(store, { type: 'agent', sessionId: aSession.id }),
    b: new PendingTreeService(store, { type: 'agent', sessionId: bSession.id }) };
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
    assert.equal(f.human.branches(f.workspace.id).length,2,'Main is not an independent agent branch');
  } finally { f.store.close(); }
});

test('Main entries are revised, removable, restored in history, and reject stale writers', () => {
  const f = fixture();
  try {
    const first = f.human.editMain(f.workspace.id, { body: 'Use the stable API', files: [file('src/api.ts')] }, 0);
    const edited = f.human.editMain(f.workspace.id, { body: 'Use API v2' }, 1, first.id);
    assert.equal(edited.id, first.id);
    assert.deepEqual(edited.files,first.files,'text-only edits retain related files');
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

test('declared files and native activity share canonical identity across nested workspace roots', () => {
  const store = new SqliteStore(':memory:');
  try {
    const human = new PendingTreeService(store,{type:'human',id:'reviewer'});
    const workspace = human.createWorkspace('nested',[{id:'repo',path:'/tmp/repo'},{id:'lib',path:'/tmp/repo/packages/lib'}]);
    const a = human.createBranch(workspace.id,'declared');
    const b = human.createBranch(workspace.id,'observed');
    const sa = human.registerSession(a.id,{id:'a',name:'A'},'claude-code','a');
    const sb = human.registerSession(b.id,{id:'b',name:'B'},'codex','b');
    const author = new PendingTreeService(store,{type:'agent',sessionId:sa.id});
    const proposal = author.proposeWork(a.id,{body:'Change library API',files:[{rootId:'repo',path:'packages/lib/api.ts'}]});
    assert.deepEqual(proposal.files,[{rootId:'lib',path:'api.ts'}]);
    human.ingest({id:'nested-observation',workspaceId:workspace.id,sessionId:sb.id,source:'codex',nativeId:'nested-observation',
      mode:'observed',type:'item/completed',payload:{changes:[{path:'/tmp/repo/packages/lib/api.ts'}]},occurredAt:new Date().toISOString()});
    const overlap = human.conflicts(workspace.id).find(c => c.branchIds.length === 2);
    assert.ok(overlap);
    assert.deepEqual(overlap.files,[{rootId:'lib',path:'api.ts'}]);
    assert.equal(overlap.status,'potential');
  } finally { store.close(); }
});

function writer(f: ReturnType<typeof fixture>) {
  const sessions = f.store.list<{ id: string; branchId: string }>('session');
  let n = 0;
  const as = (svc: PendingTreeService, branchId: string, path: string, access: 'read' | 'write') => {
    const session = sessions.find(s => s.branchId === branchId)!;
    n += 1;
    svc.ingest({ id: `w-${n}`, workspaceId: f.workspace.id, source: 'native', nativeId: `w-${n}`, sessionId: session.id, type: 'file.changed',
      mode: 'observed', payload: { touches: [{ rootId: 'repo', path, access }] }, occurredAt: new Date().toISOString() });
    return `w-${n}`;
  };
  return {
    alice: (path: string, access: 'read' | 'write' = 'write') => as(f.a, f.alice.id, path, access),
    bob: (path: string, access: 'read' | 'write' = 'write') => as(f.b, f.bob.id, path, access),
  };
}
const overlapOn = (f: ReturnType<typeof fixture>, path: string) =>
  f.human.conflicts(f.workspace.id).filter(c => c.branchIds.length === 2 && c.files.some(x => x.path === path));

test('new evidence reopens a dismissed file overlap as a new assessment', () => {
  const f = fixture();
  try {
    const w = writer(f);
    w.alice('src/shared.ts'); w.bob('src/shared.ts');
    const [first] = overlapOn(f, 'src/shared.ts');
    assert.ok(first);
    f.human.decideConflict(f.workspace.id, first.id, 'dismissed', 'Different functions in the same file');
    w.alice('src/shared.ts');
    const now = overlapOn(f, 'src/shared.ts');
    assert.equal(now.length, 1, 'the current view contains only the new assessment');
    assert.equal(now[0]!.status, 'potential');
    assert.notEqual(now[0]!.id, first.id);
    assert.ok(f.human.events(f.workspace.id).events.some(e => e.type === 'conflict.decided'), 'the previous decision remains in the audit log');
    // A different file is a different signal and still starts as potential.
    w.bob('src/other.ts'); w.alice('src/other.ts');
    assert.equal(overlapOn(f, 'src/other.ts')[0]!.status, 'potential');
  } finally { f.store.close(); }
});

test('a new proposal and a Main revision each create a fresh conflict assessment', () => {
  const f=fixture();
  try {
    f.a.proposeWork(f.alice.id,work('A',[file('src/shared.ts')]));
    const firstWork=f.b.proposeWork(f.bob.id,work('B',[file('src/shared.ts')]));
    const first=f.human.conflicts(f.workspace.id).find(c=>c.branchIds.length===2)!;
    f.human.decideConflict(f.workspace.id,first.id,'dismissed','Reviewed');
    f.b.proposeWork(f.bob.id,work('B again',[file('src/shared.ts')]));
    const next=f.human.conflicts(f.workspace.id).find(c=>c.branchIds.length===2)!;
    assert.notEqual(next.id,first.id);
    assert.equal(next.status,'potential');
    const entry=f.human.editMain(f.workspace.id,{body:'Main version one',files:[file('src/config.ts')]},0);
    f.a.proposeWork(f.alice.id,work('Change config',[file('src/config.ts')]));
    let mainSignal=f.human.conflicts(f.workspace.id).find(c=>c.mainEntryId===entry.id)!;
    f.human.decideConflict(f.workspace.id,mainSignal.id,'dismissed','Reviewed current revision');
    f.human.editMain(f.workspace.id,{body:'Main version two'},1,entry.id);
    mainSignal=f.human.conflicts(f.workspace.id).find(c=>c.mainEntryId===entry.id)!;
    assert.equal(mainSignal.status,'potential');
    assert.ok(firstWork.id);
  } finally { f.store.close(); }
});

test('completed and accepted session work do not create misleading raw activity overlaps', () => {
  const f = fixture();
  try {
    const sessions = f.store.list<{id:string;branchId:string}>('session');
    const sa = sessions.find(s => s.branchId === f.alice.id)!;
    const sb = sessions.find(s => s.branchId === f.bob.id)!;
    const event = (id:string, sessionId:string, nativeId:string, type:string, payload:unknown) => ({
      id, workspaceId:f.workspace.id, source:'native', nativeId, sessionId, type, mode:'observed' as const,
      payload, occurredAt:new Date().toISOString(),
    });
    f.a.ingest(event('turn-a',sa.id,'turn-a','item/completed',{touches:[{rootId:'repo',path:'src/result.ts',access:'write'}]}));
    f.b.ingest(event('turn-b',sb.id,'turn-b','item/completed',{touches:[{rootId:'repo',path:'src/result.ts',access:'write'}]}));
    const a=f.a.proposeWork(f.alice.id,work('A result',[file('src/result.ts')]));
    const b=f.b.proposeWork(f.bob.id,work('B result',[file('src/result.ts')]));
    f.human.decideMerge(f.alice.id,[a.id],'accepted',0,true);
    f.human.decideMerge(f.bob.id,[b.id],'accepted',1,true);
    assert.equal(overlapOn(f,'src/result.ts').length,0);
    f.a.ingest(event('late-a',sa.id,'late-a','file.changed',{touches:[{rootId:'repo',path:'src/result.ts',access:'write'}]}));
    f.b.ingest(event('late-b',sb.id,'late-b','file.changed',{touches:[{rootId:'repo',path:'src/result.ts',access:'write'}]}));
    assert.equal(overlapOn(f,'src/result.ts').length,1, 'later writes beyond the settled proposal watermark remain visible');
  } finally { f.store.close(); }
});

test('unresolved acceptance conflicts require an explicit human override and return warnings', () => {
  const f=fixture();
  try {
    const proposal=f.a.proposeWork(f.alice.id,work('Change shared file',[file('src/shared.ts')]));
    f.b.proposeWork(f.bob.id,work('Also change shared file',[file('src/shared.ts')]));
    const conflict=f.human.conflicts(f.workspace.id).find(c=>c.branchIds.length===2)!;
    assert.equal(f.human.branchOverview(f.alice.id).work.find(w=>w.id===proposal.id)?.acceptanceWarnings?.unresolvedConflictIds.includes(conflict.id),true);
    assert.throws(()=>f.human.decideMerge(f.alice.id,[proposal.id],'accepted',0),code('CONFLICT'));
    assert.equal(f.human.main(f.workspace.id).revision,0);
    const result=f.human.decideMerge(f.alice.id,[proposal.id],'accepted',0,true);
    assert.equal(result.state,'accepted');
    assert.ok(result.warnings?.unresolvedConflictIds.includes(conflict.id));
    assert.deepEqual(result.warnings?.overlappingMainEntryIds,[]);
  } finally { f.store.close(); }
});

test('acceptance rollback leaves every work and Main unchanged when a batch has an unresolved conflict',()=>{
  const f=fixture();
  try {
    const safe=f.a.proposeWork(f.alice.id,work('Safe work'));
    const contested=f.a.proposeWork(f.alice.id,work('Contested work',[file('src/shared.ts')]));
    f.b.proposeWork(f.bob.id,work('Sibling work',[file('src/shared.ts')]));
    assert.throws(()=>f.human.decideMerge(f.alice.id,[safe.id,contested.id],'accepted',0),code('CONFLICT'));
    assert.equal(f.human.main(f.workspace.id).revision,0);
    assert.equal(f.store.get<{state:string}>(safe.id,'branch-work')?.state,'proposed');
    assert.equal(f.store.get<{state:string}>(contested.id,'branch-work')?.state,'proposed');
  } finally { f.store.close(); }
});

test('a storage failure during acceptance rolls back Main and every work state',()=>{
  const f=fixture();
  try {
    const one=f.a.proposeWork(f.alice.id,work('One'));
    const two=f.a.proposeWork(f.alice.id,work('Two'));
    const originalInsert=f.store.insert.bind(f.store);
    f.store.insert=((id:string,kind:string,value:unknown) => {
      if(kind==='acceptance') throw new Error('simulated storage failure');
      return originalInsert(id,kind,value);
    }) as typeof f.store.insert;
    assert.throws(()=>f.human.decideMerge(f.alice.id,[one.id,two.id],'accepted',0),/simulated storage failure/);
    f.store.insert=originalInsert as typeof f.store.insert;
    assert.equal(f.human.main(f.workspace.id).revision,0);
    assert.equal(f.store.get<{state:string}>(one.id,'branch-work')?.state,'proposed');
    assert.equal(f.store.get<{state:string}>(two.id,'branch-work')?.state,'proposed');
  } finally { f.store.close(); }
});

test('file overlap evidence does not age out of the recent activity window', () => {
  const f = fixture();
  try {
    const w = writer(f);
    const a = w.alice('src/shared.ts'); const b = w.bob('src/shared.ts');
    for (let i = 0; i < 40; i++) w.bob(`docs/${i}.md`, 'read');
    for (let i = 0; i < 40; i++) w.alice(`notes/${i}.md`, 'read');
    const [overlap] = overlapOn(f, 'src/shared.ts');
    assert.ok(overlap, 'still reported after 40 unrelated events per branch');
    assert.equal(overlap.status, 'potential');
    assert.ok(overlap.evidenceIds.includes(a) && overlap.evidenceIds.includes(b));
    assert.equal(f.human.branchOverview(f.bob.id).recentActivity.length, 30, 'the overview window itself is unchanged');
  } finally { f.store.close(); }
});

test('agents see only corrections addressed to their own branch', () => {
  const f = fixture();
  try {
    f.human.sendCorrection(f.bob.id, 'Bob: stop editing src/shared.ts');
    f.human.sendCorrection(f.alice.id, 'Alice: keep protocol v1');
    assert.deepEqual(f.a.branchOverview(f.bob.id).corrections, [], 'a sibling branch overview hides its corrections');
    assert.equal(f.a.branchOverview(f.alice.id).corrections.length, 1);
    const view = f.a.supervision(f.workspace.id);
    assert.deepEqual(view.corrections.map(c => c.body), ['Alice: keep protocol v1']);
    assert.deepEqual(view.branches.flatMap(b => b.corrections).map(c => c.body), ['Alice: keep protocol v1']);
    assert.equal(f.human.branchOverview(f.bob.id).corrections.length, 1, 'humans still see every correction');
  } finally { f.store.close(); }
});


test('native turn completion retires raw overlap while proposed conclusions remain pending', () => {
  const f=fixture();
  try {
    const writes=writer(f);
    const before=writes.alice('src/done.ts');
    writes.bob('src/done.ts');
    assert.equal(overlapOn(f,'src/done.ts').length,1);
    const session=f.store.list<{id:string;branchId:string}>('session').find(s=>s.branchId===f.alice.id)!;
    f.a.ingest({id:'completion',nativeId:'completion',workspaceId:f.workspace.id,source:'native',sessionId:session.id,
      type:'turn/completed',mode:'observed',payload:{params:{turn:{id:'turn',status:'completed'}}},occurredAt:'2000-01-01T00:00:00Z'});
    assert.equal(overlapOn(f,'src/done.ts').length,0,'arrival sequence, not native timestamp, closes the window');
    assert.ok(f.store.event(before),'retired evidence remains available for auditing');
    const proposed=f.a.proposeWork(f.alice.id,work('Completed but awaiting integration',[file('src/done.ts')]));
    assert.equal(overlapOn(f,'src/done.ts').length,1,'an explicit pending proposal remains relevant');
    f.human.decideMerge(f.alice.id,[proposed.id],'rejected',0);
    assert.equal(overlapOn(f,'src/done.ts').length,0);
    assert.equal(f.human.main(f.workspace.id).revision,0);
  } finally { f.store.close(); }
});
