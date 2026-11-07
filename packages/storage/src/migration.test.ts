import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SqliteStore } from './index.js';
import { AgentreeService } from '../../core/src/index.js';
import { DomainError, type ContextCommit, type Workspace } from '../../contracts/src/index.js';

function legacy(existingMain = false) {
  const directory = mkdtempSync(join(tmpdir(),'agentree-v1-'));
  const path = join(directory,'state.sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(readFileSync(new URL('./fixtures/v1.sql',import.meta.url),'utf8'));
  const insert = (id: string,kind: string,data: unknown) => db.prepare('INSERT INTO entities(id,kind,data) VALUES(?,?,?)').run(id,kind,JSON.stringify(data));
  insert('w','workspace',{id:'w',name:'legacy',roots:[]});
  insert('a','agent',{id:'a',name:'author'});
  insert('b','branch',{id:'b',name:existingMain?'main':'draft',workspaceId:'w',revision:4,restricted:false});
  insert('other','branch',{id:'other',name:'other',workspaceId:'w',revision:0,restricted:false});
  insert('s','session',{id:'s',agentId:'a',workspaceId:'w',branchId:'b',runtime:'test',nativeId:'native'});
  const commits: ContextCommit[] = [
    {kind:'decision',key:'api',body:'old',scope:{type:'workspace'}},
    {kind:'decision',key:'api',body:'accepted',scope:{type:'workspace'}},
    {kind:'decision',key:'task',body:'task choice',scope:{type:'task',taskId:'t'}},
    {kind:'decision',key:'file',body:'file choice',scope:{type:'file',path:'src\\./a.ts'}},
  ].map((knowledge,i) => ({id:`c${i+1}`,workspaceId:'w',branchId:'b',revision:i+1,knowledge,provenance:{sessionId:'s',eventIds:[]},createdAt:'2026-01-01T00:00:00Z'} as ContextCommit));
  for (const c of commits) {
    insert(c.id,'commit',c);
    db.prepare('INSERT INTO branch_commits(branch_id,commit_id,revision) VALUES(?,?,?)').run('b',c.id,c.revision);
  }
  insert('m','merge',{id:'m',workspaceId:'w',sourceBranchId:'b',targetBranchId:'other',commitIds:['c2'],expectedRevision:0,state:'pending'});
  for (const seq of [3,9]) {
    const event = {id:`e${seq}`,workspaceId:'w',source:'native',nativeId:`e${seq}`,type:'message',mode:'observed',payload:{},occurredAt:'2026-01-01T00:00:00Z'};
    db.prepare('INSERT INTO events(rowid,id,workspace_id,source,native_id,data) VALUES(?,?,?,?,?,?)').run(seq,event.id,'w','native',event.nativeId,JSON.stringify(event));
  }
  db.close();
  return {directory,path,commits};
}

test('v1 upgrade preserves immutable records, event order, and authoritative decision choices', () => {
  const f = legacy();
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(f.path);
    const human = new AgentreeService(store,{type:'human',id:'reviewer'});
    const w = human.workspace('w');
    assert.ok(w.mainBranchId);
    assert.deepEqual(human.contextRevision(w.mainBranchId),{branchRevision:0,mainRevision:0});
    assert.equal(human.branches('w').find(b => b.id === w.mainBranchId)!.restricted,true);
    assert.deepEqual(human.context('b'),f.commits);
    assert.deepEqual(human.lookup('b').map(c => c.id).sort(),['c2','c3','c4']);
    assert.deepEqual(human.events('w',{source:'native'}).events.map(e => e.sequence),[3,9]);
    assert.equal(human.events('w',{type:'workspace.main-initialized'}).events.length,1);
    assert.equal(human.applyMerge('m').state,'applied');
    // Replacing a migrated decision must use the same identity as its backfill.
    const branch = human.createBranch('w','proposal');
    const session = human.registerSession(branch.id,{id:'new-agent',name:'new'},'test','new');
    const author = new AgentreeService(store,{type:'agent',sessionId:session.id});
    const incoming = author.publish(branch.id,{kind:'decision',key:'api',body:'replacement',scope:{type:'workspace'}});
    const merge = human.createMerge(branch.id,'b',[incoming.id],4);
    assert.ok(merge.reviewId);
    human.resolveReview(merge.reviewId!,'approved');
    human.applyMerge(merge.id);
    assert.deepEqual(human.lookup('b').filter(c => c.knowledge.key === 'api').map(c => c.id),[incoming.id]);
    assert.ok(human.events('w',{afterSequence:9}).events.every(e => e.sequence > 9));
    assert.deepEqual(store.get('c1'),f.commits[0]);
    store.close();
    store = new SqliteStore(f.path);
    assert.equal(store.get<Workspace>('w')!.mainBranchId,w.mainBranchId);
    assert.equal(Number(store.db.prepare('PRAGMA user_version').get()!.user_version),2);
    assert.equal(new AgentreeService(store,{type:'human',id:'reviewer'}).branches('w').filter(b => b.name === 'main').length,1);
  } finally {
    store?.close();
    rmSync(f.directory,{recursive:true,force:true});
  }
});

test('v1 existing main is adopted and old unpinned merges become stale', () => {
  const f = legacy(true);
  const store = new SqliteStore(f.path);
  try {
    const human = new AgentreeService(store,{type:'human',id:'reviewer'});
    assert.equal(human.workspace('w').mainBranchId,'b');
    assert.equal(human.branches('w').find(b => b.id === 'b')!.restricted,true);
    assert.throws(() => human.applyMerge('m'),error => error instanceof DomainError && error.code === 'STALE');
    assert.deepEqual(human.context('other').map(c => c.id),f.commits.map(c => c.id));
    assert.deepEqual(store.get('c2'),f.commits[1]);
  } finally {
    store.close();
    rmSync(f.directory,{recursive:true,force:true});
  }
});
