import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createGateway } from '../src/gateway.js';
import { ManagedCodex } from '../packages/adapters/src/codex-managed.js';
import { runManagedClaude } from '../packages/adapters/src/claude-launcher.js';

const runtime=process.argv[2];
if(runtime!=='codex'&&runtime!=='claude')throw new Error('Usage: npm run smoke:native -- codex|claude');
const directory=mkdtempSync(join(tmpdir(),'agentree-native-smoke-'));
const database=join(directory,'gateway.sqlite');const adminToken=randomBytes(32).toString('hex');
writeFileSync(join(directory,'smoke.txt'),'AGENTREE_NATIVE_SMOKE\n');
const gateway=createGateway({database,adminToken,approvalTimeoutMs:15000});
await new Promise<void>(resolve=>gateway.server.listen(0,'127.0.0.1',resolve));
const address=gateway.server.address();if(!address||typeof address==='string')throw new Error('No Gateway socket');
const gatewayUrl=`http://127.0.0.1:${address.port}`;
let native:ManagedCodex|undefined;
let dispatchEvidence:unknown;
const headers={authorization:`Bearer ${adminToken}`,'content-type':'application/json'};
// Smoke review grants only literal reads of the one synthetic fixture; all other tool requests are denied.
const reviews=setInterval(()=>{void (async()=>{
 const response=await fetch(`${gatewayUrl}/v1/approvals`,{headers});
 const pending=await response.json() as Array<{id:string;state:string;tool:string;input:{command?:string|unknown[];file_path?:string}}>;
 for(const approval of pending.filter(a=>a.state==='pending')) {
   const command=Array.isArray(approval.input.command)?approval.input.command.join(' '):approval.input.command??'';
   const readOnly=(approval.tool==='Read'&&approval.input.file_path===join(directory,'smoke.txt'))||/^cat (?:\.\/)?smoke\.txt$/.test(command)||/ -[lc]+ cat smoke\.txt$/.test(command);
   // MCP collaboration is separately authorized by its bound Core service.
   const mcp=approval.tool.startsWith('mcp__agentree__');
   await fetch(`${gatewayUrl}/v1/approvals/${approval.id}`,{method:'POST',headers,body:JSON.stringify({decision:readOnly||mcp?'approved':'denied',reason:'Native smoke fixture-only review'})});
 }
})().catch(error=>process.stderr.write(`Smoke review: ${error instanceof Error?error.message:String(error)}\n`));},100);
try {
 const prompt='Use the agentree MCP work_propose tool now. Propose work with body "AGENTREE_NATIVE_SMOKE" and no files. Then say SMOKE_OK. Do not use any other tools or modify files.';
 let sessionId:string|undefined;
 if(runtime==='codex') {
  native=await ManagedCodex.open({gatewayUrl,databasePath:database,cwd:directory,adminToken,stateDirectory:join(directory,'state'),adapter:{args:['app-server','--listen','stdio://','-c','mcp_servers={}'],threadStartParams:{approvalPolicy:'untrusted',sandbox:'read-only'}}});
  sessionId=native.gateway.session.id;
  console.log(JSON.stringify({phase:'registered',runtime,sessionId,nativeId:native.binding.nativeId}));
  const readyDeadline=Date.now()+10000;let ready=false;
  while(Date.now()<readyDeadline&&!ready) {
   const lifecycle=await (await fetch(`${gatewayUrl}/v1/sessions/${sessionId}`,{headers})).json() as {taskDispatch?:{available:boolean}};
   ready=lifecycle.taskDispatch?.available===true;
   if(!ready)await new Promise(resolve=>setTimeout(resolve,100));
  }
  if(!ready)throw new Error('Managed Codex runner did not become available');
  const task=await (await fetch(`${gatewayUrl}/v1/tasks`,{method:'POST',headers,body:JSON.stringify({sessionId,instructions:prompt,requestId:'native-smoke-dispatch-1'})})).json() as {id:string;status:string};
  if(task.status!=='submitted')throw new Error(`Task was not queued for the live Codex runner: ${task.status}`);
  console.log(JSON.stringify({phase:'task-submitted',taskId:task.id,status:task.status}));
  const deadline=Date.now()+180000;let latest=task;
  while(Date.now()<deadline&&!['completed','failed','delivery-unavailable','outcome-unknown'].includes(latest.status)) {
   await new Promise(resolve=>setTimeout(resolve,250));
   latest=await (await fetch(`${gatewayUrl}/v1/tasks/${task.id}`,{headers})).json() as typeof task;
  }
  console.log(JSON.stringify({phase:'task-terminal',taskId:latest.id,status:latest.status}));
  if(latest.status!=='completed')throw new Error(`Dispatched task ${latest.status}`);
  dispatchEvidence=latest;
 }else {
  const previous=process.env.HARNESS_ADMIN_TOKEN;process.env.HARNESS_ADMIN_TOKEN=adminToken;
  try {
   const code=await runManagedClaude({cwd:directory,label:'Claude native smoke',databasePath:database,gatewayUrl,command:process.env.CLAUDE_COMMAND??'claude',args:['-p',prompt,'--max-turns','8','--strict-mcp-config']});
   if(code!==0)throw new Error(`Claude exited ${code}`);
  }finally {if(previous===undefined)delete process.env.HARNESS_ADMIN_TOKEN;else process.env.HARNESS_ADMIN_TOKEN=previous;}
  const sessions=await (await fetch(`${gatewayUrl}/v1/sessions`,{headers})).json() as Array<{id:string}>;sessionId=sessions[0]?.id;
 }
 if(!sessionId)throw new Error('Native session was not registered');
 const session=await (await fetch(`${gatewayUrl}/v1/sessions/${sessionId}`,{headers})).json() as {workspaceId:string;branchId:string};
 const snapshot=await (await fetch(`${gatewayUrl}/v1/branches/${session.branchId}/work`,{headers})).json() as {work:Array<{body:string;state:string}>};
 if(!snapshot.work.some(w=>w.body.includes('AGENTREE_NATIVE_SMOKE')&&w.state==='proposed'))throw new Error('Native agent did not propose work through MCP');
 const events=await (await fetch(`${gatewayUrl}/v1/workspaces/${session.workspaceId}/events?limit=1000`,{headers})).json() as {events:Array<{source:string;nativeId:string;sessionId?:string}>};
 const nativeEvents=events.events.filter(event=>event.sessionId===sessionId&&event.source.startsWith(runtime==='codex'?'codex-app-server:':'claude-code:'));
 if(nativeEvents.length===0)throw new Error('No native observations reached Gateway');
 const identities=nativeEvents.map(event=>`${event.source}:${event.nativeId}`);
 if(new Set(identities).size!==identities.length)throw new Error('Native events were duplicated');
 if(native) {
  const replay=await native.gateway.ingest(nativeEvents[0] as Parameters<typeof native.gateway.ingest>[0]);
  if(replay)throw new Error('Gateway accepted a retried native event twice');
 }
 writeFileSync(join(directory,'evidence.json'),JSON.stringify({runtime,sessionId,dispatch:dispatchEvidence,snapshot,events},null,2),{mode:0o600});
 console.log(JSON.stringify({phase:'passed',runtime,evidence:join(directory,'evidence.json')}));
}finally{clearInterval(reviews);await native?.close();await gateway.close();console.log(`Smoke state: ${directory}`);}
