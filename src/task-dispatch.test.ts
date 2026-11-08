import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { startLocal } from '../apps/cli/src/start.js';
import { createGateway } from './gateway.js';
import { ManagedCodex } from '../packages/adapters/src/codex-managed.js';

const admin='task-test-admin-token-with-at-least-thirty-two-characters';

test('human dispatch is durable, idempotent, session-bound, and reconciled from native turn evidence',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'agentree-dispatch-'));
  const database=join(dir,'db.sqlite');
  let gateway=createGateway({database});
  let url=await listen(gateway);
  const call=async(path:string,token:string,method='GET',payload?:unknown)=>fetch(url+path,{method,headers:{authorization:`Bearer ${token===admin?await readHumanToken(database):token}`,...(payload?{'content-type':'application/json'}:{})},body:payload?JSON.stringify(payload):undefined});
  try{
    assert.equal((await fetch(url+'/v1/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:'anonymous',instructions:'no',requestId:'anonymous'})})).status,401);
    const codex=await (await call('/v1/sessions',admin,'POST',{runtime:'codex-app-server',cwd:dir,label:'Codex'})).json() as {sessionId:string;sessionToken:string;workspaceId:string;branchId:string};
    const claude=await (await call('/v1/sessions',admin,'POST',{runtime:'claude-code',cwd:dir,label:'Claude'})).json() as {sessionId:string;sessionToken:string};
    const input={sessionId:codex.sessionId,instructions:'Read README and propose one finding',includeMain:true,requestId:'human-click-1'};
    const unavailable=await (await call('/v1/tasks',admin,'POST',input)).json() as {id:string;status:string};
    assert.equal(unavailable.status,'delivery-unavailable','registration alone is not a live runner');
    assert.equal((await call('/v1/native/tasks/next',codex.sessionToken)).status,200);
    const submitted=await (await call('/v1/tasks',admin,'POST',{...input,requestId:'human-click-2'})).json() as {id:string;status:string;submittedBy:string};
    assert.equal(submitted.status,'submitted');
    assert.equal(submitted.submittedBy,'local-admin');
    assert.equal((await (await call('/v1/tasks',admin,'POST',{...input,requestId:'human-click-2'})).json() as {id:string}).id,submitted.id);
    assert.equal((await call('/v1/tasks',admin,'POST',{...input,instructions:'different',requestId:'human-click-2'})).status,409);
    assert.equal((await call('/v1/tasks',codex.sessionToken,'POST',{...input,requestId:'forged'})).status,403);
    assert.equal((await call(`/v1/native/tasks/${submitted.id}`,claude.sessionToken)).status,403);
    const claimed=await (await call('/v1/native/tasks/next',codex.sessionToken)).json() as {id:string;status:string};
    assert.equal(claimed.id,submitted.id);
    assert.equal(claimed.status,'delivery-pending');
    assert.equal(await (await call('/v1/native/tasks/next',codex.sessionToken)).json(),null);
    assert.equal((await call(`/v1/native/tasks/${submitted.id}/accepted`,claude.sessionToken,'POST',{nativeTurnId:'turn-1'})).status,403);
    assert.equal((await call(`/v1/native/tasks/${submitted.id}/accepted`,codex.sessionToken,'POST',{nativeTurnId:'turn-1'})).status,200);
    const observed=(type:string,status?:string)=>call('/v1/events',codex.sessionToken,'POST',{
      id:crypto.randomUUID(),workspaceId:codex.workspaceId,sessionId:codex.sessionId,source:'codex-app-server:fake',nativeId:crypto.randomUUID(),type,mode:'observed',payload:{params:{turn:{id:'turn-1',...(status?{status}:{})}}},occurredAt:new Date().toISOString(),
    });
    assert.equal((await observed('turn/started')).status,200);
    assert.equal((await (await call(`/v1/tasks/${submitted.id}`,admin)).json() as {status:string}).status,'running');
    assert.equal((await observed('turn/completed','completed')).status,200);
    assert.equal((await (await call(`/v1/tasks/${submitted.id}`,admin)).json() as {status:string}).status,'completed');
    const claudeTask=await (await call('/v1/tasks',admin,'POST',{sessionId:claude.sessionId,instructions:'do work',requestId:'claude-1'})).json() as {status:string;reason:string};
    assert.equal(claudeTask.status,'delivery-unavailable');
    assert.match(claudeTask.reason,/Claude/);
    const events=await (await call(`/v1/workspaces/${codex.workspaceId}/events`,admin)).json() as {events:{type:string}[]};
    assert.ok(events.events.some(e=>e.type==='task.submitted'));
    assert.ok(events.events.some(e=>e.type==='task.completed'));
    const pending=await (await call('/v1/tasks',admin,'POST',{...input,requestId:'restart-1'})).json() as {id:string};
    await call('/v1/native/tasks/next',codex.sessionToken);
    await gateway.close();
    gateway=createGateway({database});url=await listen(gateway);
    assert.equal((await (await call(`/v1/tasks/${pending.id}`,admin)).json() as {status:string}).status,'outcome-unknown');
  }finally{await gateway.close();await rm(dir,{recursive:true,force:true});}
});

async function listen(gateway:ReturnType<typeof createGateway>):Promise<string>{
  await new Promise<void>(resolve=>gateway.server.listen(0,'127.0.0.1',resolve));
  const address=gateway.server.address();assert.ok(address&&typeof address!=='string');
  return `http://127.0.0.1:${address.port}`;
}

async function readHumanToken(database:string):Promise<string>{return (await readFile(`${database}.human-token`,'utf8')).trim();}

test('managed Codex runner consumes a human task through a fake App Server',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'agentree-managed-dispatch-'));
  const script=join(dir,'fake.cjs');
  await writeFile(script,`const readline=require('node:readline');let n=0;const send=x=>console.log(JSON.stringify(x));readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.method)return;if(m.method==='thread/start'){send({id:m.id,result:{thread:{id:'fake-native-thread'}}});return}if(m.method==='thread/resume'){send({id:m.id,result:{}});return}if(m.method==='turn/start'){const id='turn-'+(++n);send({id:m.id,result:{turn:{id}}});send({method:'turn/started',params:{threadId:'fake-native-thread',turn:{id,status:'inProgress'}}});setTimeout(()=>send({method:'turn/completed',params:{threadId:'fake-native-thread',turn:{id,status:'completed'}}}),25);return}send({id:m.id,result:{}})});`);
  const gateway=createGateway({database:join(dir,'db.sqlite')});
  const url=await listen(gateway);
  let native:ManagedCodex|undefined;
  try{
    native=await ManagedCodex.open({gatewayUrl:url,databasePath:join(dir,'db.sqlite'),cwd:dir,label:'fake Codex',stateDirectory:join(dir,'native'),adapter:{command:process.execPath,args:[script]}});
    const request=async(path:string,method='GET',body?:unknown)=>fetch(url+path,{method,headers:{authorization:`Bearer ${await readHumanToken(join(dir,'db.sqlite'))}`,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    const deadline=Date.now()+3000;
    await new Promise(r=>setTimeout(r,300));
    const result=await request('/v1/tasks','POST',{sessionId:native.binding.sessionId,instructions:'Inspect the project',requestId:'fake-runner-task'});
    const task=await result.json() as {id:string;status:string};
    assert.equal(task.status,'submitted','managed runner should register its polling presence');
    while(Date.now()<deadline){
      const current=await (await request(`/v1/tasks/${task.id}`)).json() as {status:string;nativeTurnId?:string};
      if(current.status==='completed'){assert.ok(current.nativeTurnId);return;}
      await new Promise(r=>setTimeout(r,50));
    }
    assert.fail('Fake native turn did not complete through the dispatch path');
  }finally{await native?.close();await gateway.close();await rm(dir,{recursive:true,force:true});}
});

test('startLocal creates the daemon on first run and reuses its local database on repeated startup',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'agentree-start-local-'));
  const previous={home:process.env.AGENTREE_HOME,port:process.env.PORT,noOpen:process.env.AGENTREE_NO_OPEN};
  const reservation=createServer();
  await new Promise<void>(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const address=reservation.address();assert.ok(address&&typeof address!=='string');
  const port=address.port;await new Promise<void>(resolve=>reservation.close(()=>resolve()));
  process.env.AGENTREE_HOME=dir;process.env.PORT=String(port);process.env.AGENTREE_NO_OPEN='1';
  try{
    const first=await startLocal();
    const firstUrl=new URL(first);
    assert.equal(`${firstUrl.origin}${firstUrl.pathname}`,`http://127.0.0.1:${port}/`);
    assert.match(firstUrl.hash,/^#agentree-ticket=/);
    assert.equal((await (await fetch(`${firstUrl.origin}/health`)).json() as {application:string;database:string}).application,'agentree');
    const second=await startLocal();
    assert.equal(new URL(second).origin,firstUrl.origin);
    assert.notEqual(new URL(second).hash,firstUrl.hash,'each launcher invocation issues a fresh ticket');
    process.env.AGENTREE_HOME=join(dir,'different-home');
    await assert.rejects(startLocal(), /another service or Agentree data directory/);
    process.env.AGENTREE_HOME=dir;
    assert.equal((await fetch(`${firstUrl.origin}/v1/workspaces`)).status,401,'the returned fragment URL does not grant access until exchanged');
    const ticket=decodeURIComponent(firstUrl.hash.slice('#agentree-ticket='.length));
    const exchange=await fetch(`${firstUrl.origin}/v1/console-session`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ticket})});
    assert.equal(exchange.status,200);
    const cookie=exchange.headers.get('set-cookie')!.split(';',1)[0]!;
    assert.equal((await fetch(`${firstUrl.origin}/v1/workspaces`,{headers:{cookie}})).status,200);
  }finally{
    // startLocal deliberately detaches its daemon. Locate only the process
    // carrying this test's unique AGENTREE_HOME and ask it to shut down.
    if(process.platform==='linux'){
      const fs=await import('node:fs/promises');
      for(const entry of await fs.readdir('/proc')){
        if(!/^\d+$/.test(entry))continue;
        try{
          const env=await fs.readFile(`/proc/${entry}/environ`,'utf8');
          const cmd=await fs.readFile(`/proc/${entry}/cmdline`,'utf8');
          if(env.split('\0').includes(`AGENTREE_HOME=${dir}`)&&cmd.includes('src/index.ts'))process.kill(Number(entry),'SIGTERM');
        }catch{}
      }
    }
    if(previous.home===undefined)delete process.env.AGENTREE_HOME;else process.env.AGENTREE_HOME=previous.home;
    if(previous.port===undefined)delete process.env.PORT;else process.env.PORT=previous.port;
    if(previous.noOpen===undefined)delete process.env.AGENTREE_NO_OPEN;else process.env.AGENTREE_NO_OPEN=previous.noOpen;
    await rm(dir,{recursive:true,force:true});
  }
});
