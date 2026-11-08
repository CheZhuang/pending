import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { SqliteStore } from '../../storage/src/index.js';
import { NativeGatewayClient, type NativeConnection } from './gateway-client.js';
import { CodexAppServerAdapter, type CodexAppServerOptions } from './codex-app-server.js';
import { SqliteCursorStore } from './sqlite-cursor-store.js';
import { cursorKey, ingestNextBatch, type SessionBinding } from './index.js';
import { nativeMcpConfig } from './native-config.js';

export interface ManagedCodexOptions {
  gatewayUrl:string;
  databasePath:string;
  cwd:string;
  label?:string;
  branchId?:string;
  /** Supply the private registration file to recover an active native session. */
  resumeFile?:string;
  stateDirectory?:string;
  adapter?:Omit<CodexAppServerOptions,'onServerRequest'|'initialCursor'>;
}

export async function gatewayCodexApproval(client:NativeGatewayClient,request:{method:string;params?:unknown},cwd:string) {
  if(request.method==='mcpServer/elicitation/request') {
    const p=request.params as {threadId?:string;turnId?:string;serverName?:string;message?:string;_meta?:{codex_approval_kind?:string;tool_params?:unknown}}|undefined;
    if(p?.threadId!==client.session.nativeId||!p.turnId||p.serverName!=='pendingtree'||p._meta?.codex_approval_kind!=='mcp_tool_call')return {action:'decline'};
    const toolName=/run tool "([a-z_]+)"\?/.exec(p.message??'')?.[1];
    if(!toolName)return {action:'decline'};
    const hash=createHash('sha256').update(JSON.stringify([p.turnId,toolName,p._meta.tool_params])).digest('hex');
    try {
      const decision=await client.decide(`codex:mcp:${p.threadId}:${hash}`,`mcp__pendingtree__${toolName}`,p._meta.tool_params,cwd);
      return decision.outcome==='allow'?{action:'accept',content:{}}:{action:'decline'};
    }catch{return {action:'decline'};}
  }
  if(request.method!=='item/commandExecution/requestApproval'&&request.method!=='item/fileChange/requestApproval')throw new Error('Unsupported Codex approval request');
  const p=request.params as {threadId?:string;turnId?:string;itemId?:string}|undefined;
  if(!p||p.threadId!==client.session.nativeId||!p.turnId||!p.itemId)return {decision:'decline'};
  try {
    const decision=await client.decide(`codex:${p.threadId}:${p.turnId}:${p.itemId}:${request.method}`,request.method,request.params,cwd);
    // Accept only this request, never a session-wide grant or policy amendment.
    return {decision:decision.outcome==='allow'?'accept':'decline'};
  }catch{return {decision:'decline'};}
}

/** Managed native thread, session-bound HTTP ingestion and durable checkpoint recovery. */
export class ManagedCodex {
  private stopping=false;
  private failure:unknown;
  private activeTurnId?:string;
  private dispatchedTaskId?:string;
  private interruptionSent=false;
  private deliveryInFlight=false;
  private deliveryPromise?:Promise<void>;
  private readonly completed=new Map<string,{id:string;status:string;error?:unknown}>();
  private pumpTask?:Promise<void>;
  private lastCorrectionPollAt = 0;
  private readonly notifiedCorrections = new Set<string>();
  private constructor(
    readonly adapter:CodexAppServerAdapter, readonly gateway:NativeGatewayClient,
    readonly registrationFile:string, private readonly store:SqliteStore,
    private readonly cursors:SqliteCursorStore, readonly binding:SessionBinding,
  ) {}
  static async open(options:ManagedCodexOptions):Promise<ManagedCodex> {
    const cwd=resolve(options.cwd);
    const directory=resolve(options.stateDirectory??join(homedir(),'.local','share','pendingtree','native'));
    mkdirSync(directory,{recursive:true,mode:0o700});
    const store=new SqliteStore(join(directory,'adapter-state.sqlite'));
    const cursors=new SqliteCursorStore(store);
    let adapter:CodexAppServerAdapter|undefined;
    let gateway:NativeGatewayClient|undefined;
    let created=false;
    let journalPath:string|undefined;
    try {
      if(options.resumeFile) {
        const connection=JSON.parse(readFileSync(options.resumeFile,'utf8')) as NativeConnection & {journalPath?:string;cwd?:string;databasePath?:string};
        if(connection.gatewayUrl!==options.gatewayUrl)throw new Error('Resume registration belongs to a different Gateway');
        if(connection.cwd&&connection.cwd!==cwd)throw new Error('Resume working directory differs from registered thread');
        if(connection.databasePath&&connection.databasePath!==resolve(options.databasePath))throw new Error('Resume database differs from registered session');
        gateway=await NativeGatewayClient.attach(connection);
        journalPath=connection.journalPath;
      }else {
        // Discover the native thread ID before the trusted admin registers it.
        journalPath=join(directory,`bootstrap-${randomUUID()}.json`);
        const bootstrapArgs=[...(options.adapter?.args??['app-server','--listen','stdio://']),'-c','mcp_servers={}'];
        adapter=await CodexAppServerAdapter.start({...options.adapter,cwd,args:bootstrapArgs,journalPath,threadStartParams:{...options.adapter?.threadStartParams,approvalPolicy:'never',sandbox:'read-only'},onServerRequest:async()=>({decision:'decline'})});
        const nativeId=adapter.nativeId;
        const bootstrap=await adapter.startTurn('Reply READY. Do not use tools.');
        const bootstrapId=(bootstrap as {turn?:{id?:string}}).turn?.id;
        if(!bootstrapId)throw new Error('Codex bootstrap turn returned no id');
        const deadline=Date.now()+120000;
        let bootstrapDone=false;
        while(Date.now()<deadline&&!bootstrapDone) {
          const batch=await adapter.readEvents({runtime:'codex-app-server',nativeId});
          bootstrapDone=batch.records.some(record=>record.type==='turn/completed'&&(record.payload as {params?:{turn?:{id:string;status:string}}}).params?.turn?.id===bootstrapId);
          if(!bootstrapDone)await new Promise(resolve=>setTimeout(resolve,100));
        }
        if(!bootstrapDone)throw new Error('Codex bootstrap turn did not complete');
        await adapter.close();adapter=undefined;
        gateway=await NativeGatewayClient.register(options.gatewayUrl,{runtime:'codex-app-server',cwd,label:options.label??'Codex',branchId:options.branchId,nativeId},options.databasePath);
        created=true;
      }
      if(gateway.session.runtime!=='codex-app-server')throw new Error('Resume registration is not a Codex App Server session');
      const binding:SessionBinding={runtime:gateway.session.runtime,nativeId:gateway.session.nativeId,cwd,sessionId:gateway.session.id,workspaceId:gateway.session.workspaceId,branchId:gateway.session.branchId};
      const registrationFile=options.resumeFile??join(directory,`${gateway.session.id}.json`);
      if(!options.resumeFile) {
        const temporary=`${registrationFile}.${randomUUID()}.tmp`;
        writeFileSync(temporary,JSON.stringify({...gateway.connection,journalPath,cwd,databasePath:resolve(options.databasePath)}),{mode:0o600,flush:true});renameSync(temporary,registrationFile);
      }
      const mcp=nativeMcpConfig(resolve(options.databasePath),gateway.connection);
      const args=options.adapter?.args??['app-server','--listen','stdio://'];
      const configured=[...args,'-c',`mcp_servers.pendingtree.command=${JSON.stringify(mcp.command)}`,'-c',`mcp_servers.pendingtree.args=${JSON.stringify(mcp.args)}`,'-c',`mcp_servers.pendingtree.env_vars=${JSON.stringify(Object.keys(mcp.env))}`];
      adapter=await CodexAppServerAdapter.resume(gateway.session.nativeId,{...options.adapter,cwd,args:configured,env:{...process.env,...options.adapter?.env,...mcp.env},threadResumeParams:{...options.adapter?.threadResumeParams,approvalPolicy:options.adapter?.threadStartParams?.approvalPolicy??'untrusted',sandbox:options.adapter?.threadStartParams?.sandbox??'workspace-write'},journalPath:journalPath??join(directory,`${gateway.session.nativeId}.events.json`),initialCursor:await cursors.get(cursorKey(binding)),onServerRequest:request=>gatewayCodexApproval(gateway!,request,cwd)});
      const result=new ManagedCodex(adapter,gateway,registrationFile,store,cursors,binding);
      if (adapter.processId) void gateway.bindProcess(adapter.processId).catch(() => undefined);
      result.pumpTask=result.pump();
      return result;
    }catch(error){await adapter?.close();if(created)await gateway?.end().catch(()=>undefined);store.close();throw error;}
  }
  async startTurn(prompt:string):Promise<{turn:{id:string}}> {
    if(this.failure)throw this.failure;
    if(this.activeTurnId||this.deliveryInFlight)throw new Error('Managed Codex is busy with another turn');
    const result=await this.adapter.startTurn(prompt) as {turn?:{id?:string}};
    if(!result.turn?.id)throw new Error('Native turn/start returned no turn ID');
    this.activeTurnId=result.turn.id;
    return result as {turn:{id:string}};
  }
  async waitForTurn(turnId:string,timeoutMs=180000) {
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline) {
      if(this.failure)throw this.failure;
      const result=this.completed.get(turnId);if(result)return result;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    await this.adapter.interruptTurn(turnId).catch(()=>undefined);
    throw new Error('Codex turn smoke deadline exceeded');
  }
  async flush():Promise<void> {
    let more=true;
    while(more) {
      const batch=await ingestNextBatch(this.adapter,this.binding,this.cursors,this.gateway);
      for(const record of batch.records) {
        const payload=record.payload as {params?:{turn?:{id:string;status:string;error?:unknown}}};
        if(record.type==='turn/completed'&&payload.params?.turn)this.completed.set(payload.params.turn.id,payload.params.turn);
        if(record.type==='turn/completed'&&payload.params?.turn?.id===this.activeTurnId){this.activeTurnId=undefined;this.dispatchedTaskId=undefined;this.interruptionSent=false;}
      }
      more=batch.hasMore;
    }
  }
  private async pump():Promise<void> {
    try {
      while(!this.stopping) {
        await this.gateway.authorize(); // also stops on kill-requested/revocation
        await this.flush();
        if(this.dispatchedTaskId&&this.activeTurnId&&!this.interruptionSent){
          const task=await this.gateway.request(`/v1/native/tasks/${encodeURIComponent(this.dispatchedTaskId)}`) as {status:string};
          if(task.status==='cancel-requested'){
            this.interruptionSent=true;
            await this.adapter.interruptTurn(this.activeTurnId).catch(()=>undefined);
          }
        }
        if(Date.now()-this.lastCorrectionPollAt>=1000){
          this.lastCorrectionPollAt=Date.now();
          await this.deliverCorrections();
        }
        const next=await this.gateway.request(`/v1/native/tasks/next${this.activeTurnId||this.deliveryInFlight?'?busy=1':''}`) as {id:string;instructions:string;mainContext?:{entries:{body:string}[]}|null}|null;
        if(next&&!this.activeTurnId&&!this.deliveryInFlight){
          this.dispatchedTaskId=next.id;
          this.deliveryInFlight=true;
          this.deliveryPromise=this.deliver(next).finally(()=>{this.deliveryInFlight=false;});
        }
        await new Promise(resolve=>setTimeout(resolve,100));
      }
    }catch(error){this.failure=error;this.stopping=true;await this.adapter.close();}
  }
  private async deliverCorrections():Promise<void>{
    if(!this.activeTurnId&&(this.dispatchedTaskId||this.deliveryInFlight))return;
    const pending=await this.gateway.request(`/v1/sessions/${encodeURIComponent(this.gateway.session.id)}/corrections/pending`) as Array<{itemId:string;value:{body:string}}>;
    for(const item of pending){
      try{
        if(!this.notifiedCorrections.has(item.itemId)){
          const prompt=`A new human correction for this PendingTree branch has arrived. Follow it as current human direction, reconsider affected work, and acknowledge its item ID with PendingTree context_acknowledge after reading it.\n\n${item.value.body}\n\nCorrection item ID: ${item.itemId}`;
          if(this.activeTurnId) await this.adapter.steerTurn(this.activeTurnId,prompt);
          else {
            const started=await this.adapter.startTurn(prompt) as {turn?:{id?:string}};
            if(!started.turn?.id)throw new Error('Correction turn returned no turn ID');
            this.activeTurnId=started.turn.id;
          }
          this.notifiedCorrections.add(item.itemId);
        }
        await this.gateway.request(`/v1/sessions/${encodeURIComponent(this.gateway.session.id)}/corrections/delivered`,'POST',{itemIds:[item.itemId]});
      }catch(error){
        // Keep the correction pending in Gateway so a later polling tick can
        // retry if the App Server cannot steer the active turn right now.
        console.error(`[PendingTree] Could not deliver correction ${item.itemId}: ${error instanceof Error?error.message:String(error)}`);
      }
    }
  }
  private async deliver(next:{id:string;instructions:string;mainContext?:{entries:{body:string}[]}|null}):Promise<void>{
    try{
      const latest=await this.gateway.request(`/v1/native/tasks/${encodeURIComponent(next.id)}`) as {status:string};
      if(latest.status==='cancel-requested'){
        await this.gateway.request(`/v1/native/tasks/${encodeURIComponent(next.id)}/unavailable`,'POST',{reason:'Cancelled before native start'});
        this.dispatchedTaskId=undefined;
        return;
      }
      const prompt=next.mainContext?.entries?.length?`${next.instructions}\n\nRelevant human Main context:\n${next.mainContext.entries.map(e=>`- ${e.body}`).join('\n')}`:next.instructions;
      const result=await this.adapter.startTurn(prompt) as {turn?:{id?:string}};
      if(!result.turn?.id)throw new Error('Native turn/start returned no turn ID');
      this.activeTurnId=result.turn.id;
      await this.gateway.request(`/v1/native/tasks/${encodeURIComponent(next.id)}/accepted`,'POST',{nativeTurnId:result.turn.id});
    }catch(error){
      await this.gateway.request(`/v1/native/tasks/${encodeURIComponent(next.id)}/unavailable`,'POST',{reason:error instanceof Error?error.message:String(error)}).catch(()=>undefined);
      this.dispatchedTaskId=undefined;
    }
  }
  async close():Promise<void> {
    this.stopping=true;
    try {
      await this.pumpTask;
      // Stop native work before the final drain, then end only the logical session.
      await this.adapter.close();
      await this.deliveryPromise?.catch(()=>undefined);
      if(!this.failure) {
        await this.flush();
        await this.gateway.end();
      }
    } finally {this.store.close();}
  }
}
