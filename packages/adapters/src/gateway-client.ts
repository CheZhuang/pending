import { z } from 'zod';
import type { NormalizedEvent, Session } from '../../contracts/src/index.js';
import type { RegisterManagedSessionRequest, RegisterManagedSessionResponse, ToolDecisionResponse } from '../../contracts/src/gateway.js';

const sessionSchema = z.object({ id:z.string().min(1), workspaceId:z.string().min(1), branchId:z.string().min(1), agentId:z.string().min(1), nativeId:z.string().min(1), runtime:z.string().min(1) });
export interface NativeConnection { gatewayUrl:string; sessionId:string; sessionToken:string }

/** Session credential is resolved by the runtime host, never by model arguments. */
export class NativeGatewayClient {
  constructor(readonly connection:NativeConnection, readonly session:Session) {}
  static async register(gatewayUrl:string, request:RegisterManagedSessionRequest):Promise<NativeGatewayClient> {
    const response=await fetch(new URL('/v1/sessions',gatewayUrl),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw new Error(`Gateway registration failed: HTTP ${response.status}`);
    const result=await response.json() as RegisterManagedSessionResponse;
    const session=sessionSchema.parse(result);
    if(typeof result.sessionToken!=='string'||!result.sessionToken)throw new Error('Gateway returned no session credential');
    return new NativeGatewayClient({gatewayUrl,sessionId:session.id,sessionToken:result.sessionToken},session);
  }
  static async attach(connection:NativeConnection):Promise<NativeGatewayClient> {
    const response=await fetch(new URL(`/v1/sessions/${encodeURIComponent(connection.sessionId)}`,connection.gatewayUrl),{headers:{authorization:`Bearer ${connection.sessionToken}`},signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error(`Gateway session authentication failed: HTTP ${response.status}`);
    const session=sessionSchema.parse(await response.json());
    if(session.id!==connection.sessionId)throw new Error('Gateway returned a different session');
    return new NativeGatewayClient(connection,session);
  }
  async authorize():Promise<void> { await NativeGatewayClient.attach(this.connection); }
  async request(path:string, method='GET', body?:unknown, timeoutMs=10000):Promise<unknown> {
    const response=await fetch(new URL(path,this.connection.gatewayUrl),{method,headers:{authorization:`Bearer ${this.connection.sessionToken}`,...(body!==undefined?{'content-type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(timeoutMs)});
    if(!response.ok)throw new Error(`Gateway ${method} ${path} failed: HTTP ${response.status}`);
    return response.json();
  }
  async ingest(event:NormalizedEvent):Promise<boolean> {
    if(event.sessionId!==this.session.id||event.workspaceId!==this.session.workspaceId||event.mode!=='observed')throw new Error('Event does not belong to this bound session');
    const result=await this.request('/v1/events','POST',event) as {inserted:boolean};
    if(typeof result.inserted!=='boolean')throw new Error('Invalid ingestion acknowledgement');
    return result.inserted;
  }
  async decide(requestId:string,tool:string,input:unknown,cwd?:string):Promise<ToolDecisionResponse> {
    const result=await this.request('/v1/decide','POST',{requestId,sessionId:this.session.id,nativeSessionId:this.session.nativeId,tool,input,cwd},100000) as ToolDecisionResponse;
    if(result.outcome!=='allow'&&result.outcome!=='deny')throw new Error('Gateway returned an unresolved decision');
    return result;
  }
  async end(exit?:{exitCode:number|null;signal:string|null}):Promise<void> {
    await this.request(`/v1/sessions/${encodeURIComponent(this.session.id)}/end`,'POST',exit??{});
  }
}
