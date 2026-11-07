import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServerAdapter } from './codex-app-server.js';
import { runManagedClaude } from './claude-launcher.js';
import { MockGatewayClient } from './mock.js';
import { SqliteStore } from '../../storage/src/index.js';
import { AgentreeService } from '../../core/src/index.js';
import { createAgentreeMcpServer } from '../../mcp/src/index.js';
import { extractTouches, MemoryLedger } from '../../sync/src/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const fakeRpc = `
const send = x => console.log(JSON.stringify(x));
let turn;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if (!m.method) {
   if(m.id===turn && m.result?.decision==='decline')send({id:turn,result:{accepted:true}});
   return;
 }
 if(!m.id)return;
 if(m.method==='turn/start'){
   turn=m.id;send({id:turn,method:'item/commandExecution/requestApproval',params:{threadId:'thread-demo'}});return;
 }
 if(m.method==='thread/start'||m.method==='thread/resume')send({method:'item/completed',params:{threadId:'thread-demo',item:{id:process.argv[2],changes:[{path:'src/a.ts'}]}}});
 send({id:m.id,result:m.method==='thread/start'?{thread:{id:'thread-demo'}}:{}});
});`;

async function fixture() {
 const dir=await mkdtemp(join(tmpdir(),'agentree-regression-'));
 const script=join(dir,'rpc.cjs');await writeFile(script,fakeRpc);
 return {dir, options:(marker:string)=>({command:process.execPath,cwd:dir,args:[script,marker],journalPath:join(dir,'journal.json')})};
}

test('Codex answers a server request even when its ID matches a client request', async()=>{
 const f=await fixture();let adapter:CodexAppServerAdapter|undefined;
 try {
  adapter=await CodexAppServerAdapter.start(f.options('first'));
  assert.deepEqual(await adapter.startTurn('demo'),{accepted:true});
 } finally {await adapter?.close();await rm(f.dir,{recursive:true,force:true});}
});

test('uncheckpointed observations replay with their original IDs after restart', async()=>{
 const f=await fixture();let adapter:CodexAppServerAdapter|undefined;
 try {
  const gateway=new MockGatewayClient();
  adapter=await CodexAppServerAdapter.start(f.options('first'));
  const binding={...(await adapter.discoverSessions())[0]!,sessionId:'s',workspaceId:'w',branchId:'b'};
  const first=await adapter.readEvents(binding);
  assert.equal(first.records.length,1);
  assert.deepEqual(extractTouches(adapter.normalize(first.records[0]!,binding),[{id:'root',path:f.dir}]), [{rootId:'root',path:'src/a.ts',access:'write'}]);
  await gateway.ingest(adapter.normalize(first.records[0]!,binding));
  // Model a crash after ingestion but before the cursor is saved.
  await adapter.close();
  adapter=await CodexAppServerAdapter.resume('thread-demo',{...f.options('second'),initialCursor:{value:'0'}});
  const replay=await adapter.readEvents(binding,{value:'0'});
  assert.equal(replay.records.length,2);
  assert.equal(replay.records[0]!.nativeId,first.records[0]!.nativeId);
  assert.notEqual(replay.records[1]!.nativeId,first.records[0]!.nativeId);
  for(const record of replay.records)await gateway.ingest(adapter.normalize(record,binding));
  assert.equal(gateway.events().length,2);
  adapter.acknowledge(replay.nextCursor);
  await adapter.close();
  adapter=await CodexAppServerAdapter.resume('thread-demo',{...f.options('third'),initialCursor:replay.nextCursor});
  const next=await adapter.readEvents(binding,replay.nextCursor);
  assert.equal(next.records.length,1);
  assert.equal(next.nextCursor.value,'3');
 } finally {await adapter?.close();await rm(f.dir,{recursive:true,force:true});}
});

test('source Claude launcher executes its hook from an unrelated project directory',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'agentree-claude-regression-'));
 const child=join(dir,'fake-claude.cjs');let ended=false;
 try {
  await writeFile(child,`#!${process.execPath}\nconst fs=require('node:fs');const cp=require('node:child_process');const settings=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));const out=cp.execSync(settings.hooks.PreToolUse[0].hooks[0].command,{input:'{}',encoding:'utf8'});if(JSON.parse(out).hookSpecificOutput.permissionDecision!=='deny')process.exit(2);`,{mode:0o700});
  const exit=await runManagedClaude({cwd:dir,label:'regression',command:child,gateway:{
   async registerSession(){return {sessionId:'test',afterSeq:0};},
   async *stream(_seq,signal){await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));},
   async endSession(){ended=true;},
  }});
  assert.equal(exit,0);assert.equal(ended,true);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('MCP sync delivers merged context from a peer branch',async()=>{
 const store=new SqliteStore(':memory:');
 const admin=new AgentreeService(store,{type:'human',id:'reviewer'});
 const w=admin.createWorkspace('review');const target=admin.createBranch(w.id,'target');const source=admin.createBranch(w.id,'source');
 const ts=admin.registerSession(target.id,{id:'t',name:'target'},'mock','tn');const ss=admin.registerSession(source.id,{id:'s',name:'source'},'mock','sn');
 const t=new AgentreeService(store,{type:'agent',sessionId:ts.id});const s=new AgentreeService(store,{type:'agent',sessionId:ss.id});
 for(let i=0;i<2;i++)t.publish(target.id,{kind:'finding',key:'t'+i,body:'target',scope:{type:'workspace'}});
 const incoming=s.publish(source.id,{kind:'finding',key:'incoming',body:'merged',scope:{type:'workspace'}});
 admin.applyMerge(admin.createMerge(source.id,target.id,[incoming.id],2).id);
 const server=createAgentreeMcpServer({session:ts,service:t,ledger:new MemoryLedger()});const client=new Client({name:'regression',version:'1'});
 const [ct,st]=InMemoryTransport.createLinkedPair();
 try {
  await server.connect(st);await client.connect(ct);
  await client.callTool({name:'context_subscribe',arguments:{scopes:[{type:'workspace'}]}});
  const result=await client.callTool({name:'context_sync',arguments:{requestId:'merged-context'}});
  const data=(result.structuredContent as {data:{items:{commitId:string}[]}}).data;
  assert.deepEqual(data.items.map(c=>c.commitId),[incoming.id]);
 }finally{await client.close();await server.close();store.close();}
});
