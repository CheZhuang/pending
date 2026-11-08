import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createGateway } from './gateway.js';
import type { ProcessProvider, ProcessSnapshot } from '../packages/adapters/src/process-discovery.js';

const adminToken = 'process-discovery-admin-token-long-enough';
let directory: string;
let baseUrl: string;
let gateway: ReturnType<typeof createGateway>;
let database: string;
let rows: ProcessSnapshot[] = [];
let scans = 0;
let releaseInitial!: () => void;
const initialScan = new Promise<void>(resolve => { releaseInitial = resolve; });
let firstScan = true;
const provider: ProcessProvider = { enumerate: async () => {
  scans++;
  if (firstScan) { firstScan = false; await initialScan; }
  return rows;
} };

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agentree-process-discovery-'));
  database = join(directory, 'gateway.sqlite');
  gateway = createGateway({ database, processProvider: provider, discoveryIntervalMs: 60_000 });
  await new Promise<void>(resolve => gateway.server.listen(0, '127.0.0.1', resolve));
  const address = gateway.server.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await gateway.close();
  await rm(directory, { recursive: true, force: true });
});

test('GET waits for initial discovery and refresh is administrator-only', async () => {
  rows = [{ pid: 5101, startTime: 'linux:boot:100', executable: '/usr/bin/codex', argv: ['codex'] }];
  const beforeScan = scans;
  let completed = false;
  const pending = request('/v1/processes').then(response => { completed = true; return response; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(completed, false, 'GET waits while the initial process provider scan is pending');
  releaseInitial();
  const result = await pending;
  assert.equal(result.status, 200);
  const inventory = await result.json() as { status: string; processes: Array<{ pid: number; capabilities: Record<string, boolean> }> };
  assert.equal(inventory.status, 'ok');
  assert.equal(scans, beforeScan, 'GET shares the in-flight startup scan rather than starting a duplicate');
  assert.equal(inventory.processes[0]?.pid, 5101);
  assert.deepEqual(inventory.processes[0]?.capabilities, {
    passiveObservation: false, managedSession: false, contextInjection: false, preExecutionInterception: false,
  });

  const session = await register('claude-code');
  assert.equal((await request('/v1/processes/refresh', session.sessionToken, 'POST')).status, 403);
  assert.equal((await request('/v1/processes/refresh', adminToken, 'POST')).status, 200);
});

test('session process association requires its bearer and exact discovered runtime identity', async () => {
  const session = await register('claude-code');
  const codex = { pid: 6201, startTime: 'birth:6201', executable: 'codex', argv: ['codex'] };
  const claude = { pid: 6202, startTime: 'birth:6202', executable: '/usr/local/bin/claude', argv: ['claude'] };
  rows = [codex, claude];
  await request('/v1/processes/refresh', adminToken, 'POST');

  const path = `/v1/sessions/${encodeURIComponent(session.sessionId)}/process`;
  assert.equal((await request(path, adminToken, 'POST', { pid: claude.pid, startTime: claude.startTime })).status, 403,
    'admin identity is not a session capability');
  assert.equal((await request(path, session.sessionToken, 'POST', { pid: codex.pid, startTime: codex.startTime })).status, 403,
    'discovered executable runtime must match registered runtime');
  assert.equal((await request(path, session.sessionToken, 'POST', { pid: claude.pid, startTime: 'reused-pid' })).status, 403,
    'PID without matching birth identity cannot associate');

  const linked = await request(path, session.sessionToken, 'POST', { pid: claude.pid, startTime: claude.startTime });
  assert.equal(linked.status, 200);
  const inventory = await (await request('/v1/processes')).json() as { processes: Array<{ pid: number; managedSessionId?: string }> };
  assert.equal(inventory.processes.find(p => p.pid === claude.pid)?.managedSessionId, session.sessionId);
  const sessions = await (await request('/v1/sessions', adminToken)).json() as Array<{ id: string; process?: { pid: number; startTime?: string } }>;
  assert.deepEqual(sessions.find(s => s.id === session.sessionId)?.process, { pid: claude.pid, startTime: claude.startTime });
  const second = await register('claude-code');
  assert.equal((await request(`/v1/sessions/${second.sessionId}/process`, second.sessionToken, 'POST', {pid:claude.pid,startTime:claude.startTime})).status, 409);
  assert.equal((await request('/v1/processes', session.sessionToken)).status, 403, 'process metadata is human-only');
  assert.equal((await request(`/v1/sessions/${second.sessionId}/process`, session.sessionToken, 'POST', {pid:claude.pid,startTime:claude.startTime})).status, 403);
  assert.equal((await request('/v1/tasks', adminToken, 'POST', {sessionId:String(claude.pid),instructions:'test',requestId:'unmanaged'})).status, 404,
    'a discovered PID is not a task delivery session');
  rows = [{...claude,startTime:'new-birth'}];
  const reused = await (await request('/v1/processes/refresh', adminToken, 'POST')).json() as {processes:Array<{managedSessionId?:string}>};
  assert.equal(reused.processes[0]?.managedSessionId, undefined, 'restarted PID does not inherit the prior managed link');
  rows = [claude];
  await request(`/v1/sessions/${session.sessionId}/end`, session.sessionToken, 'POST', {});
  const ended = await (await request('/v1/processes/refresh', adminToken, 'POST')).json() as {processes:Array<{managedSessionId?:string}>};
  assert.equal(ended.processes.length, 1, 'ending a Session does not hide a still-running OS process');
  assert.equal(ended.processes[0]?.managedSessionId, undefined);
});

async function register(runtime: string) {
  const response = await request('/v1/sessions', adminToken, 'POST', { runtime, cwd: join(directory, 'project'), label: runtime });
  assert.equal(response.status, 201);
  return await response.json() as { sessionId: string; sessionToken: string };
}

async function request(path: string, token = adminToken, method = 'GET', data?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token === adminToken ? (await readFile(`${database}.human-token`, 'utf8')).trim() : token}`, ...(data === undefined ? {} : { 'content-type': 'application/json' }) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}
