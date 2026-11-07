import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createGateway, type ToolApproval } from './gateway.js';
import { createClaudeDecideClient, handleClaudePreToolHook } from '../packages/adapters/src/claude-pre-tool-hook.js';

const adminToken = 'test-admin-token-that-is-long-enough-to-pass-validation';
let directory: string;
let database: string;
let gateway: ReturnType<typeof createGateway>;
let baseUrl: string;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agentree-gateway-test-'));
  database = join(directory, 'gateway.sqlite');
  gateway = createGateway({ database, adminToken, approvalTimeoutMs: 1200 });
  baseUrl = await listen(gateway.server);
});

after(async () => {
  await gateway.close();
  await rm(directory, { recursive: true, force: true });
});

test('Gateway credentials, approval enforcement, timeout, and SQLite recovery', async () => {
  const unauthorized = await fetch(`${baseUrl}/v1/approvals`);
  assert.equal(unauthorized.status, 401);

  const first = await registerSession();
  const second = await registerSession();
  assert.equal((await request(`/v1/approvals`, first.sessionToken)).status, 403, 'session credentials cannot access admin approvals');
  assert.equal((await request('/v1/sessions', first.sessionToken)).status, 403, 'session credentials cannot register sessions');
  assert.equal((await request(`/v1/sessions/${second.sessionId}`, first.sessionToken)).status, 403, 'session credentials cannot read another session');

  const spoof = await request('/v1/events', first.sessionToken, 'POST', {
    id: crypto.randomUUID(), workspaceId: first.workspaceId, source: 'claude-code', nativeId: 'spoofed',
    sessionId: first.sessionId, type: 'tool.executed', mode: 'controlled', payload: {}, occurredAt: new Date().toISOString(),
  });
  assert.equal(spoof.status, 400, 'observed event endpoint rejects controlled-mode claims');
  const gatewaySource = await request('/v1/events', first.sessionToken, 'POST', {
    id: crypto.randomUUID(), workspaceId: first.workspaceId, source: 'gateway', nativeId: 'spoofed-gateway',
    sessionId: first.sessionId, type: 'tool.executed', mode: 'observed', payload: {}, occurredAt: new Date().toISOString(),
  });
  assert.equal(gatewaySource.status, 400, 'clients cannot spoof reserved Gateway events');

  const approvedRequest = request('/v1/decide', first.sessionToken, 'POST', { sessionId: first.sessionId, tool: 'Read', input: { file_path: '/tmp/a' } });
  const approved = await waitForPending(first.sessionId);
  assert.equal((await request(`/v1/approvals/${approved.id}`, adminToken, 'POST', { decision: 'approved' })).status, 200);
  const allowed = await approvedRequest;
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json() as { outcome: string }).outcome, 'allow');

  // Exercise the actual Claude hook boundary: a denial output prevents the sentinel action.
  let sentinelCalls = 0;
  let pendingHook!: ToolApproval;
  const output: string[] = [];
  const hook = handleClaudePreToolHook(JSON.stringify({
    session_id: 'native-session-1', cwd: '/tmp/example', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'touch sentinel' },
  }), { HARNESS_SESSION_ID: first.sessionId }, createClaudeDecideClient(baseUrl, 2000, first.sessionToken), line => output.push(line), () => undefined);
  pendingHook = await waitForNewApproval(first.sessionId, approved.id);
  await request(`/v1/approvals/${pendingHook.id}`, adminToken, 'POST', { decision: 'denied', reason: 'Blocked for test' });
  assert.equal(await hook, 0);
  const denied = output.some(line => line.includes('"permissionDecision":"deny"'));
  if (!denied) sentinelCalls++;
  assert.equal(denied, true);
  assert.equal(sentinelCalls, 0, 'denied hook must prevent the protected action');

  const timedOutCall = request('/v1/decide', first.sessionToken, 'POST', { sessionId: first.sessionId, tool: 'Bash', input: {} });
  const timedOut = await waitForPending(first.sessionId, pendingHook.id);
  const timeoutResult = await timedOutCall;
  assert.equal((await timeoutResult.json() as { outcome: string }).outcome, 'deny');
  assert.equal((await request('/v1/approvals', adminToken)).status, 200);
  const timeoutApproval = (await (await request('/v1/approvals', adminToken)).json() as ToolApproval[]).find(a => a.id === timedOut.id)!;
  assert.equal(timeoutApproval.state, 'timeout');

  const restartCall = request('/v1/decide', first.sessionToken, 'POST', { sessionId: first.sessionId, tool: 'Write', input: {} }).catch(() => undefined);
  const restartPending = await waitForPending(first.sessionId, timedOut.id);
  await gateway.close();
  await new Promise(resolveWait => setTimeout(resolveWait, 1250));
  gateway = createGateway({ database, adminToken, approvalTimeoutMs: 100 });
  baseUrl = await listen(gateway.server);
  const restartedApprovals = await (await request('/v1/approvals', adminToken)).json() as ToolApproval[];
  assert.equal(restartedApprovals.find(a => a.id === restartPending.id)?.state, 'timeout');
  assert.ok(await restartCall === undefined, 'in-flight request is disconnected when the Gateway process closes');
  const events = await (await request(`/v1/workspaces/${first.workspaceId}/events?after=0`, adminToken)).json() as { events: Array<{type:string}> };
  assert.ok(events.events.some(e => e.type === 'tool.pending'));
  assert.ok(events.events.some(e => e.type === 'tool.decided'));
});

async function listen(server: ReturnType<typeof createGateway>['server']): Promise<string> {
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function registerSession() {
  const response = await request('/v1/sessions', adminToken, 'POST', { runtime: 'claude-code', cwd: '/tmp/example', label: 'test' });
  assert.equal(response.status, 201);
  return await response.json() as { sessionId: string; sessionToken: string; workspaceId: string };
}

async function request(path: string, token: string, method = 'GET', data?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(data === undefined ? {} : { 'content-type': 'application/json' }) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}

async function waitForPending(sessionId: string, excludeId?: string): Promise<ToolApproval> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const rows = await (await request('/v1/approvals', adminToken)).json() as ToolApproval[];
    const pending = rows.find(row => row.sessionId === sessionId && row.state === 'pending' && row.id !== excludeId);
    if (pending) return pending;
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
  assert.fail('Timed out waiting for pending approval');
}

async function waitForNewApproval(sessionId: string, previousId: string): Promise<ToolApproval> {
  return waitForPending(sessionId, previousId);
}

test('HTTP context publication, reviewed merge, and resumable SSE', async () => {
  const s = await registerSession() as Awaited<ReturnType<typeof registerSession>> & {branchId:string};
  const workspace = await (await request(`/v1/workspaces/${s.workspaceId}`, adminToken)).json() as {mainBranchId:string};
  const published = await request(`/v1/branches/${s.branchId}/context`, s.sessionToken, 'POST', {
    knowledge:{kind:'finding',key:'integration',body:'Shared context',scope:{type:'workspace'}},
  });
  assert.equal(published.status,201);
  const commit = await published.json() as {id:string};
  const snapshot = await (await request(`/v1/branches/${s.branchId}/context`,s.sessionToken)).json() as {knowledge:{id:string}[]};
  assert.ok(snapshot.knowledge.some(c=>c.id===commit.id));
  const merge = await (await request('/v1/merges',s.sessionToken,'POST',{
    sourceBranchId:s.branchId,targetBranchId:workspace.mainBranchId,commitIds:[commit.id],expectedRevision:0,
  })).json() as {id:string;reviewId:string};
  assert.equal((await request(`/v1/merges/${merge.id}/apply`,s.sessionToken,'POST')).status,409);
  assert.equal((await request(`/v1/reviews/${merge.reviewId}`,adminToken,'POST',{decision:'approved'})).status,200);
  assert.equal((await request(`/v1/merges/${merge.id}/apply`,s.sessionToken,'POST')).status,200);
  const origin = await fetch(`${baseUrl}/v1/approvals`,{headers:{authorization:`Bearer ${adminToken}`,origin:'https://untrusted.example'}});
  assert.equal(origin.status,403);
  const stream = await fetch(`${baseUrl}/v1/stream?after=0`,{headers:{authorization:`Bearer ${s.sessionToken}`},signal:AbortSignal.timeout(3000)});
  assert.equal(stream.status,200);
  const reader=stream.body!.getReader();
  const data=new TextDecoder().decode((await reader.read()).value);
  assert.match(data,/text|connected|data:/);
  await reader.cancel();
  assert.equal((await request(`/v1/sessions/${s.sessionId}/kill`,adminToken,'POST')).status,200);
  assert.equal((await request(`/v1/sessions/${s.sessionId}`,s.sessionToken)).status,403);
});
