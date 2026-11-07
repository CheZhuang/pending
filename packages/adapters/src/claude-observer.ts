import { z } from 'zod';
import { NativeGatewayClient } from './gateway-client.js';

const inputSchema=z.object({session_id:z.string().min(1),hook_event_name:z.enum(['PreToolUse','PostToolUse','PostToolUseFailure']),tool_use_id:z.string().min(1),tool_name:z.string().min(1),tool_input:z.unknown(),cwd:z.string().min(1)}).passthrough();
/** Native tool-use IDs make hook retries idempotent across process restarts. */
export async function observeClaudeHook(raw:string,env:NodeJS.ProcessEnv=process.env):Promise<boolean> {
  const input=inputSchema.parse(JSON.parse(raw));
  if(!env.HARNESS_SESSION_ID||!env.HARNESS_SESSION_TOKEN)throw new Error('Missing managed session credential');
  const client=await NativeGatewayClient.attach({gatewayUrl:env.HARNESS_GATEWAY_URL??'http://127.0.0.1:8787',sessionId:env.HARNESS_SESSION_ID,sessionToken:env.HARNESS_SESSION_TOKEN});
  if(client.session.runtime!=='claude-code'||client.session.nativeId!==input.session_id)throw new Error('Claude native session does not match its trusted registration');
  const identity=`claude-code:${input.session_id}:${input.hook_event_name}:${input.tool_use_id}`;
  return client.ingest({id:identity,nativeId:identity,source:`claude-code:${input.session_id}`,sessionId:client.session.id,workspaceId:client.session.workspaceId,mode:'observed',type:input.hook_event_name==='PreToolUse'?'tool.call':input.hook_event_name==='PostToolUse'?'tool.result':'tool.failed',payload:input,occurredAt:new Date().toISOString()});
}
