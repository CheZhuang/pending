import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../../../src/gateway.js';
import { NativeGatewayClient } from './gateway-client.js';
import { observeClaudeHook } from './claude-observer.js';
import { gatewayCodexApproval } from './codex-managed.js';

test('native connection binds Claude hook identity and deduplicates hook retries', async () => {
  const directory=await mkdtemp(join(tmpdir(),'agentree-native-test-'));
  const adminToken='native-test-admin-token-is-long-enough';
  const gateway=createGateway({database:join(directory,'gateway.sqlite'),adminToken});
  try {
    await new Promise<void>(resolve=>gateway.server.listen(0,'127.0.0.1',resolve));
    const address=gateway.server.address();assert.ok(address&&typeof address!=='string');
    const gatewayUrl=`http://127.0.0.1:${address.port}`;
    const client=await NativeGatewayClient.register(gatewayUrl,adminToken,{runtime:'claude-code',cwd:directory,label:'Claude',nativeId:'native-claude-test'});
    const env={HARNESS_GATEWAY_URL:gatewayUrl,HARNESS_SESSION_ID:client.session.id,HARNESS_SESSION_TOKEN:client.connection.sessionToken};
    const input=JSON.stringify({session_id:'native-claude-test',hook_event_name:'PreToolUse',tool_use_id:'tool-1',tool_name:'Read',tool_input:{file_path:'a'},cwd:directory});
    assert.equal(await observeClaudeHook(input,env),true);
    assert.equal(await observeClaudeHook(input,env),false);
    await assert.rejects(observeClaudeHook(JSON.stringify({...JSON.parse(input),session_id:'spoofed'}),env),/does not match/);
    const response=await fetch(`${gatewayUrl}/v1/workspaces/${client.session.workspaceId}/events?limit=100`,{headers:{authorization:`Bearer ${adminToken}`}});
    const events=(await response.json() as {events:Array<{source:string;nativeId:string}>}).events;
    assert.equal(events.filter(e=>e.nativeId==='claude-code:native-claude-test:PreToolUse:tool-1').length,1);
    await client.end();
    await assert.rejects(observeClaudeHook(input,env),/HTTP 403/);
  }finally {await gateway.close();await rm(directory,{recursive:true,force:true});}
});

test('Codex approval callback is bound to its registered thread', async () => {
  const fake={session:{nativeId:'trusted-thread'},decide:async()=>({outcome:'allow'})} as unknown as NativeGatewayClient;
  const wrong=await gatewayCodexApproval(fake,{method:'item/commandExecution/requestApproval',params:{threadId:'other-thread',turnId:'turn',itemId:'item'}},'/tmp');
  assert.deepEqual(wrong,{decision:'decline'});
  const correct=await gatewayCodexApproval(fake,{method:'item/commandExecution/requestApproval',params:{threadId:'trusted-thread',turnId:'turn',itemId:'item'}},'/tmp');
  assert.deepEqual(correct,{decision:'accept'});
  const mcp=await gatewayCodexApproval(fake,{method:'mcpServer/elicitation/request',params:{threadId:'trusted-thread',turnId:'turn',serverName:'agentree',message:'Allow the agentree MCP server to run tool "context_publish"?',_meta:{codex_approval_kind:'mcp_tool_call',tool_params:{key:'x'}}}},'/tmp');
  assert.deepEqual(mcp,{action:'accept',content:{}});
});
