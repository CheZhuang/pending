import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { NativeGatewayClient } from '../../adapters/src/gateway-client.js';
import { SqliteStore } from '../../storage/src/index.js';
import { AgentreeService } from '../../core/src/index.js';
import { EntityLedger } from '../../sync/src/index.js';
import { serveAgentreeMcp } from './index.js';

/** Local stdio host: authenticate with the Gateway before accessing its shared SQLite. */
export async function serveNativeMcp(env:NodeJS.ProcessEnv=process.env) {
  const {HARNESS_SESSION_ID:sessionId,HARNESS_SESSION_TOKEN:sessionToken,AGENTREE_DATABASE_PATH:database}=env;
  if(!sessionId||!sessionToken||!database||!existsSync(database))throw new Error('Native MCP requires a session credential and existing Gateway database');
  const client=await NativeGatewayClient.attach({gatewayUrl:env.HARNESS_GATEWAY_URL??'http://127.0.0.1:8787',sessionId,sessionToken});
  const store=new SqliteStore(database);
  try {
    const stored=store.get<typeof client.session>(sessionId,'session');
    if(!stored||JSON.stringify(stored)!==JSON.stringify(client.session)) {
      // Compare fields explicitly: JSON key order is not an identity property.
      if(!stored||Object.entries(client.session).some(([key,value])=>stored[key as keyof typeof stored]!==value))throw new Error('MCP database and Gateway session do not match');
    }
    const ledger=new EntityLedger(store,(_id,changes)=>{
      const eventId=randomUUID();
      store.appendEvent({id:eventId,workspaceId:client.session.workspaceId,sessionId,source:'gateway',nativeId:eventId,type:'correction.delivery-state',mode:'controlled',payload:{changes},occurredAt:new Date().toISOString()});
    });
    const server=await serveAgentreeMcp({session:client.session,service:new AgentreeService(store,{type:'agent',sessionId}),ledger,authorize:()=>client.authorize()});
    const close=async()=>{await server.close();store.close();};
    process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());
    return {server,store,close};
  }catch(error){store.close();throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void serveNativeMcp().catch(error=>{process.stderr.write(`Agentree MCP: ${error instanceof Error?error.message:String(error)}\n`);process.exitCode=1;});
