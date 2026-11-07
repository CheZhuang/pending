import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createGateway } from './gateway.js';
import type { ToolApproval } from '../packages/contracts/src/gateway.js';

const adminToken = 'regression-admin-token-with-at-least-thirty-two-characters';
const consoleOrigin = 'http://localhost:5173';
let directory: string;
let gateway: ReturnType<typeof createGateway>;
let baseUrl: string;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agentree-gateway-regression-'));
  gateway = createGateway({ database: join(directory, 'gateway.sqlite'), adminToken,
    consoleOrigins: [consoleOrigin] });
  baseUrl = await listen();
});

after(async () => {
  await gateway.close();
  await rm(directory, { recursive: true, force: true });
});

test('decision requests are idempotent by request ID and payload', async () => {
  const session = await registerSession();
  const payload = { requestId: 'request-allow-1', sessionId: session.sessionId, tool: 'Read', input: { path: '/tmp/a' } };

  const firstRequest = api('/v1/decide', session.sessionToken, 'POST', payload);
  const pending = await waitForApproval(session.sessionId);
  const duplicateRequest = api('/v1/decide', session.sessionToken, 'POST', payload);
  assert.equal((await (await api(`/v1/approvals/${pending.id}`, adminToken, 'POST', { decision: 'approved' })).json() as ToolApproval).state, 'approved');
  const firstResult = await firstRequest;
  const duplicateResult = await duplicateRequest;
  const firstBody = await firstResult.json() as { approvalId: string; outcome: string };
  const duplicateBody = await duplicateResult.json() as { approvalId: string; outcome: string };
  assert.equal(firstBody.outcome, 'allow');
  assert.equal(duplicateBody.outcome, 'allow');
  assert.equal(duplicateBody.approvalId, firstBody.approvalId);

  await gateway.close();
  gateway=createGateway({database:join(directory,'gateway.sqlite'),adminToken,consoleOrigins:[consoleOrigin]});
  baseUrl=await listen();
  const terminalReplay = await api('/v1/decide', session.sessionToken, 'POST', payload);
  assert.equal(terminalReplay.status, 200);
  assert.deepEqual(await terminalReplay.json(), firstBody);

  const mismatch = await api('/v1/decide', session.sessionToken, 'POST', { ...payload, tool: 'Write' });
  assert.equal(mismatch.status, 409, 'reusing a request ID with a different payload must conflict');

  const missingId = await api('/v1/decide', session.sessionToken, 'POST', { sessionId: session.sessionId, tool: 'Read', input: {} });
  assert.equal(missingId.status, 400, 'requestId is required');
});

test('kill request, exit report, and pending approvals are safe and separately audited', async () => {
  const session = await registerSession();
  const decisionRequest = api('/v1/decide', session.sessionToken, 'POST', {
    requestId: 'request-kill-pending', sessionId: session.sessionId, tool: 'Bash', input: { command: 'sleep' },
  });
  const approval = await waitForApproval(session.sessionId);

  const kill = await api(`/v1/sessions/${session.sessionId}/kill`, adminToken, 'POST');
  assert.equal(kill.status, 202);
  const killBody = await kill.json() as { state: string };
  assert.equal(killBody.state, 'kill-requested');

  const end = await api(`/v1/sessions/${session.sessionId}/end`, session.sessionToken, 'POST', { exitCode: 0, signal: null });
  assert.equal(end.status, 200);
  const ended=await end.json() as {state:string;processStatus:string};
  assert.equal(ended.state,'ended');assert.equal(ended.processStatus,'exit-reported');
  const status=await (await api(`/v1/sessions/${session.sessionId}`,adminToken)).json() as {processStatus:string;exit:{exitCode:number}};
  assert.equal(status.processStatus,'exit-reported');assert.equal(status.exit.exitCode,0);
  const decisionResponse = await decisionRequest;
  assert.equal((await decisionResponse.json() as { outcome: string }).outcome, 'deny');
  const rows = await (await api('/v1/approvals', adminToken)).json() as ToolApproval[];
  assert.equal(rows.find(row => row.id === approval.id)?.state, 'denied');

  const workspaceId = session.workspaceId;
  const page = await (await api(`/v1/workspaces/${workspaceId}/events?after=0`, adminToken)).json() as { events: Array<{ type: string; sessionId?: string }> };
  const types = page.events.filter(event => event.sessionId === session.sessionId).map(event => event.type);
  assert.ok(types.includes('session.kill-requested'));
  assert.ok(types.includes('session.exited'));
  assert.ok(!types.includes('session.killed'));
  assert.ok(!types.includes('session.ended'));
});

test('Console cookie authentication enforces configured browser origins', async () => {
  const session = await registerSession();
  const options = await fetch(`${baseUrl}/v1/console/login`, {
    method: 'OPTIONS', headers: { origin: consoleOrigin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
  });
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('access-control-allow-origin'), consoleOrigin);

  const login = await fetch(`${baseUrl}/v1/console/login`, {
    method: 'POST', headers: { origin: consoleOrigin, authorization: `Bearer ${adminToken}` },
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.ok(cookie, 'login returns a Console session cookie');
  const cookiePair = cookie.split(';', 1)[0]!;

  const approvals = await fetch(`${baseUrl}/v1/approvals`, { headers: { cookie: cookiePair, origin: consoleOrigin } });
  assert.equal(approvals.status, 200);
  assert.ok(Array.isArray(await approvals.json()));

  const cookiePost = await fetch(`${baseUrl}/v1/approvals/missing`, {
    method: 'POST', headers: { cookie: cookiePair, origin: consoleOrigin, 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'denied' }),
  });
  assert.equal(cookiePost.status, 404, 'valid cookie and matching origin reaches the admin route');

  const noOriginWrite=await fetch(`${baseUrl}/v1/console/logout`,{method:'POST',headers:{cookie:cookiePair}});
  assert.equal(noOriginWrite.status,403);
  const stream=await fetch(`${baseUrl}/v1/stream`,{headers:{cookie:cookiePair,origin:consoleOrigin}});
  assert.equal(stream.status,200);
  await stream.body!.cancel();
  const wrongOrigin = await fetch(`${baseUrl}/v1/approvals`, { headers: { cookie: cookiePair, origin: 'https://evil.example' } });
  assert.equal(wrongOrigin.status, 403);
  const bearerLogin = await fetch(`${baseUrl}/v1/console/login`, {
    method: 'POST', headers: { origin: consoleOrigin, authorization: `Bearer ${session.sessionToken}` },
  });
  assert.equal(bearerLogin.status, 403, 'session bearer credentials cannot mint admin Console cookies');
  const untrustedOrigin = await fetch(`${baseUrl}/v1/console/login`, {
    method: 'POST', headers: { origin: 'https://evil.example', authorization: `Bearer ${adminToken}` },
  });
  assert.equal(untrustedOrigin.status, 403);
});

async function listen(): Promise<string> {
  await new Promise<void>(resolveListen => gateway.server.listen(0, '127.0.0.1', resolveListen));
  const address = gateway.server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function registerSession() {
  const response = await api('/v1/sessions', adminToken, 'POST', { runtime: 'claude-code', cwd: '/tmp/example', label: `regression-${crypto.randomUUID()}` });
  assert.equal(response.status, 201);
  return await response.json() as { sessionId: string; sessionToken: string; workspaceId: string };
}

async function api(path: string, token: string, method = 'GET', data?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(data === undefined ? {} : { 'content-type': 'application/json' }) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}

async function waitForApproval(sessionId: string): Promise<ToolApproval> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const response = await api('/v1/approvals', adminToken);
    if (response.ok) {
      const rows = await response.json() as ToolApproval[];
      const approval = rows.find(row => row.sessionId === sessionId && row.state === 'pending');
      if (approval) return approval;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
  assert.fail('Timed out waiting for pending approval');
}
