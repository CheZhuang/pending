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

  const approvedRequest = request('/v1/decide', first.sessionToken, 'POST', { sessionId: first.sessionId, requestId:'read-1', tool: 'Read', input: { file_path: '/tmp/a' } });
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

  const timedOutCall = request('/v1/decide', first.sessionToken, 'POST', { sessionId: first.sessionId, requestId:'bash-1', tool: 'Bash', input: {} });
  const timedOut = await waitForPending(first.sessionId, pendingHook.id);
  const timeoutResult = await timedOutCall;
  assert.equal((await timeoutResult.json() as { outcome: string }).outcome, 'deny');
  assert.equal((await request('/v1/approvals', adminToken)).status, 200);
  const timeoutApproval = (await (await request('/v1/approvals', adminToken)).json() as ToolApproval[]).find(a => a.id === timedOut.id)!;
  assert.equal(timeoutApproval.state, 'timeout');

  const restartCall = request('/v1/decide', first.sessionToken, 'POST', { sessionId: first.sessionId, requestId:'write-1', tool: 'Write', input: {} }).catch(() => undefined);
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

test('HTTP Main, branch work, human acceptance, and resumable SSE', async () => {
  const s = await registerSession() as Awaited<ReturnType<typeof registerSession>> & {branchId:string};
  const mainPath=`/v1/workspaces/${s.workspaceId}/main`;
  const initial=await (await request(mainPath,adminToken)).json() as {revision:number;entries:unknown[]};
  assert.equal(initial.revision,0);
  assert.equal((await request(mainPath,s.sessionToken,'POST',{body:'agent cannot edit',expectedRevision:0})).status,403);
  const proposed=await request(`/v1/branches/${s.branchId}/work`,s.sessionToken,'POST',{body:'Shared context',files:[]});
  assert.equal(proposed.status,201);
  const work=await proposed.json() as {id:string};
  const overview=await (await request(`/v1/branches/${s.branchId}/work`,s.sessionToken)).json() as {work:{id:string}[]};
  assert.ok(overview.work.some(item=>item.id===work.id));
  const accepted=await request(`/v1/branches/${s.branchId}/merge`,adminToken,'POST',{
    workIds:[work.id],decision:'accepted',expectedMainRevision:0,
  });
  assert.equal(accepted.status,201);
  const updated=await (await request(mainPath,adminToken)).json() as {revision:number;entries:Array<{body:string;sourceWorkId:string}>};
  assert.equal(updated.revision,1);
  assert.equal(updated.entries[0]?.body,'Shared context');
  assert.equal(updated.entries[0]?.sourceWorkId,work.id);
  const stale=await request(`/v1/branches/${s.branchId}/merge`,adminToken,'POST',{
    workIds:[work.id],decision:'accepted',expectedMainRevision:0,
  });
  assert.equal(stale.status,409);
  const origin = await fetch(`${baseUrl}/v1/approvals`,{headers:{authorization:`Bearer ${adminToken}`,origin:'https://untrusted.example'}});
  assert.equal(origin.status,403);
  const stream = await fetch(`${baseUrl}/v1/stream?after=0`,{headers:{authorization:`Bearer ${s.sessionToken}`},signal:AbortSignal.timeout(3000)});
  assert.equal(stream.status,200);
  const reader=stream.body!.getReader();
  const data=new TextDecoder().decode((await reader.read()).value);
  assert.match(data,/text|connected|data:/);
  await reader.cancel();
  assert.equal((await request(`/v1/sessions/${s.sessionId}/kill`,adminToken,'POST')).status,202);
  assert.equal((await request(`/v1/sessions/${s.sessionId}`,s.sessionToken)).status,403);
});

test('Main history, conflicts, and corrections use authenticated human routes', async()=>{
  const s=await registerSession() as Awaited<ReturnType<typeof registerSession>>&{branchId:string};
  const mainPath=`/v1/workspaces/${s.workspaceId}/main`;
  const before=await (await request(mainPath,adminToken)).json() as {revision:number};
  const first=await request(mainPath,adminToken,'POST',{body:'Initial guidance',files:[],expectedRevision:before.revision});
  assert.equal(first.status,201);
  const entry=await first.json() as {id:string};
  const update=await request(`${mainPath}/${entry.id}`,adminToken,'POST',{body:'Updated guidance',files:[],expectedRevision:before.revision+1});
  assert.equal(update.status,200);
  const history=await request(`${mainPath}/${entry.id}/history`,adminToken);
  assert.equal((await history.json() as unknown[]).length,2);
  const correction=await request(`/v1/branches/${s.branchId}/corrections`,adminToken,'POST',{body:'Please re-read Main'});
  assert.equal(correction.status,201);
  const overview=await request(`/v1/branches/${s.branchId}/work`,s.sessionToken);
  assert.equal(overview.status,200);
  assert.ok(((await overview.json()) as {corrections:Array<{body:string}>}).corrections.some(c=>c.body==='Please re-read Main'));
  const reported=await request(`/v1/workspaces/${s.workspaceId}/conflicts`,adminToken,'POST',{
    branchIds:[s.branchId],explanation:'Human reported a review concern',
  });
  assert.equal(reported.status,201);
  const conflict=await reported.json() as {id:string;status:string};
  assert.equal(conflict.status,'potential');
  const decided=await request(`/v1/workspaces/${s.workspaceId}/conflicts/${conflict.id}`,adminToken,'POST',{
    status:'confirmed',explanation:'Reviewed and confirmed',
  });
  assert.equal((await decided.json() as {status:string}).status,'confirmed');
  assert.equal((await request(`/v1/workspaces/${s.workspaceId}/conflicts/${conflict.id}`,s.sessionToken,'POST',{
    status:'dismissed',explanation:'agent attempt',
  })).status,403);
  assert.equal((await request(`/v1/branches/${s.branchId}/corrections`,s.sessionToken,'POST',{body:'agent attempt'})).status,403);
});

test('HTTP text-only Main edit keeps file references; an explicit empty list clears them', async () => {
  const s = await registerSession();
  const workspace = await (await request(`/v1/workspaces/${s.workspaceId}`, adminToken)).json() as { roots: Array<{ id: string }> };
  const rootId = workspace.roots[0]!.id;
  const mainPath = `/v1/workspaces/${s.workspaceId}/main`;
  const revision = async () => ((await (await request(mainPath, adminToken)).json()) as { revision: number }).revision;
  const created = await (await request(mainPath, adminToken, 'POST', { body: 'Tokens expire after 15 minutes', files: [{ rootId, path: 'src/auth/token.ts' }], expectedRevision: await revision() })).json() as { id: string; files: unknown[] };
  assert.equal(created.files.length, 1);
  const textOnly = await request(`${mainPath}/${created.id}`, adminToken, 'POST', { body: 'Tokens expire after 30 minutes', expectedRevision: await revision() });
  assert.equal(textOnly.status, 200);
  const kept = await textOnly.json() as { body: string; files: unknown[] };
  assert.equal(kept.body, 'Tokens expire after 30 minutes');
  assert.equal(kept.files.length, 1, 'omitting files keeps the existing references');
  const cleared = await (await request(`${mainPath}/${created.id}`, adminToken, 'POST', { body: 'Tokens expire after 30 minutes', files: [], expectedRevision: await revision() })).json() as { files: unknown[] };
  assert.equal(cleared.files.length, 0, 'an explicit empty list clears them');
});
