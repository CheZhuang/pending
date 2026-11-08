import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createGateway } from './gateway.js';

let directory: string;
let database: string;
let gateway: ReturnType<typeof createGateway>;
let baseUrl: string;
let human: string;

before(async () => { directory = await mkdtemp(join(tmpdir(), 'pendingtree-security-')); database = join(directory, 'gateway.sqlite'); await start(); });
after(async () => { await gateway.close(); await rm(directory, { recursive: true, force: true }); });

test('anonymous writes cannot mutate Main, approvals, conflicts, tasks, or registrations', async () => {
  const a = await register('a');
  const main = `/v1/workspaces/${a.workspaceId}/main`;
  const seed = await call(main, human, 'POST', { body: 'trusted entry', expectedRevision: 0 });
  const entry = await seed.json() as { id: string };
  const anon = async (path: string, method = 'GET', body?: unknown) => call(path, undefined, method, body);
  for (const [path, method, body] of [
    ['/v1/sessions', 'POST', { runtime: 'test', cwd: directory, label: 'anonymous' }],
    ['/v1/workspaces', 'POST', { name: 'anonymous', roots: [] }],
    [main, 'POST', { body: 'forged', expectedRevision: 1 }],
    [`${main}/${entry.id}`, 'POST', { body: 'forged edit', expectedRevision: 1 }],
    [`${main}/restore`, 'POST', { revision: 0, expectedRevision: 0 }],
    [`${main}/${entry.id}/restore`, 'POST', { revision: 1, expectedRevision: 1 }],
    [`/v1/workspaces/${a.workspaceId}/conflicts`, 'POST', { branchIds: [a.branchId], explanation: 'forged' }],
    ['/v1/tasks', 'POST', { sessionId: a.sessionId, instructions: 'forged', requestId: 'anon-task' }],
    ['/v1/approvals/not-an-id', 'POST', { decision: 'approved' }],
  ] as const) assert.equal((await anon(path, method, body)).status, 401, `${method} ${path}`);
  for (const path of ['/v1/approvals', '/v1/sessions', main, `/v1/workspaces/${a.workspaceId}/conflicts`, '/v1/tasks', '/v1/console-ticket'])
    assert.equal((await anon(path)).status, 401, `anonymous GET ${path} must not expose sensitive data or mint a ticket`);
  const after = await (await call(main, human)).json() as { revision: number; entries: Array<{ id: string; body: string }> };
  assert.equal(after.revision, 1);
  assert.equal(after.entries.find(row => row.id === entry.id)?.body, 'trusted entry');
  assert.deepEqual(await (await call('/v1/tasks', human)).json(), []);
  assert.deepEqual(await (await call('/v1/approvals', human)).json(), []);
  assert.equal(((await (await call('/v1/sessions', human)).json()) as unknown[]).length, 1);
});

test('agent capabilities cannot perform human operations or cross session boundaries', async () => {
  const one = await register('one'); const two = await register('two');
  const main = `/v1/workspaces/${one.workspaceId}/main`;
  for (const [path, method, body] of [
    ['/v1/sessions', 'POST', { runtime: 'test', cwd: directory, label: 'spoof' }],
    ['/v1/workspaces', 'POST', { name: 'spoof', roots: [] }],
    [main, 'POST', { body: 'spoof', expectedRevision: 0, actor: 'human' }],
    [`${main}/restore`, 'POST', { revision: 0, expectedRevision: 0, actor: 'human' }],
    [`/v1/workspaces/${one.workspaceId}/conflicts`, 'POST', { branchIds: [one.branchId], explanation: 'spoof', actor: 'human' }],
    ['/v1/tasks', 'POST', { sessionId: one.sessionId, instructions: 'spoof', requestId: 'agent-task', actor: 'human' }],
    ['/v1/approvals/fake', 'POST', { decision: 'approved', actor: 'human' }],
  ] as const) assert.equal((await call(path, one.token, method, body)).status, 403, `${method} ${path}`);
  assert.equal((await call(`/v1/sessions/${two.sessionId}/end`, one.token, 'POST', {})).status, 403);
  assert.equal((await call(`/v1/sessions/${two.sessionId}/process`, one.token, 'POST', { pid: 1, startTime: 'x' })).status, 403);
  assert.equal((await call('/v1/decide', one.token, 'POST', { sessionId: two.sessionId, requestId: 'cross', tool: 'Read', input: {} })).status, 403);
  assert.equal((await call('/v1/decide', one.token, 'POST', { sessionId: one.sessionId, nativeSessionId: 'wrong-native-id', requestId: 'wrong-native', tool: 'Read', input: {} })).status, 403);
  assert.equal((await call(`/v1/branches/${two.branchId}/corrections`, one.token, 'POST', { body: 'cross' })).status, 403);
  const task = await (await call('/v1/tasks', human, 'POST', { sessionId: one.sessionId, instructions: 'task', requestId: 'accept-boundary' })).json() as { id: string };
  assert.equal((await call(`/v1/native/tasks/${task.id}/accepted`, two.token, 'POST', { nativeTurnId: 'turn' })).status, 403);
  assert.equal((await call(`/v1/sessions/${two.sessionId}/end`, human, 'POST', {})).status, 200);
  assert.equal((await call(`/v1/sessions/${two.sessionId}`, human)).status, 200);
  const humanCookie = await mintTicket();
  const cookieResponse = await exchange(humanCookie);
  const cookie = cookieResponse.headers.get('set-cookie')!.split(';', 1)[0]!;
  assert.equal((await call('/v1/workspaces', one.token, 'GET', undefined, { cookie })).status, 403, 'agent bearer takes precedence over a valid human cookie');
});

test('tickets expire, replay fails, cookies and tickets are process scoped, local tokens persist', async () => {
  const ticket = await mintTicket();
  const expired = await mintTicket();
  const pendingTicket = await mintTicket();
  const preRestartHuman = human;
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + 61_000;
    assert.equal((await exchange(expired)).status, 401);
  } finally { Date.now = originalNow; }
  const issued = await exchange(ticket);
  assert.equal(issued.status, 200);
  const cookie = issued.headers.get('set-cookie')!.split(';', 1)[0]!;
  assert.equal((await exchange(ticket)).status, 401, 'ticket cannot be replayed');
  assert.equal((await call('/v1/workspaces', undefined, 'GET', undefined, { cookie })).status, 200);
  const session = await register('persist');
  await gateway.close(); await start();
  assert.equal((await call('/v1/workspaces', undefined, 'GET', undefined, { cookie })).status, 401, 'old browser cookie is process scoped');
  assert.equal((await exchange(ticket)).status, 401, 'old ticket is process scoped');
  assert.equal((await call('/v1/workspaces', human)).status, 200, 'local human capability remains stable');
  assert.equal(human, preRestartHuman, 'the human capability itself remains unchanged');
  assert.equal((await call(`/v1/branches/${session.branchId}/work`, session.token)).status, 200, 'agent session capability remains stable');
  assert.equal((await exchange(pendingTicket)).status, 401, 'unconsumed ticket is process scoped too');
});

test('unconfigured loopback origins are rejected even with a human credential', async () => {
  const response = await call('/v1/workspaces', human, 'GET', undefined, { origin: 'http://localhost:5173' });
  assert.equal(response.status, 403);
});

test('session revocation during a slow request body prevents branch work', async () => {
  const agent = await register('slow-body');
  const requestReceived = new Promise<void>(resolve => gateway.server.once('request', () => resolve()));
  const raw = httpRequest(`${baseUrl}/v1/branches/${agent.branchId}/work`, { method: 'POST', headers: { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' } });
  const responsePromise = new Promise<number>((resolve, reject) => {
    raw.on('response', response => { response.resume(); response.on('end', () => resolve(response.statusCode ?? 0)); });
    raw.on('error', reject);
  });
  raw.flushHeaders();
  raw.write('{"body":"slow');
  await requestReceived;
  assert.equal((await call(`/v1/sessions/${agent.sessionId}/end`, human, 'POST', {})).status, 200);
  raw.end(' work","files":[]}');
  assert.equal(await responsePromise, 403);
  const overview = await (await call(`/v1/branches/${agent.branchId}/work`, human)).json() as { work: unknown[] };
  assert.deepEqual(overview.work, []);
});

async function start() {
  gateway = createGateway({ database });
  human = (await readFile(`${database}.human-token`, 'utf8')).trim();
  await new Promise<void>(resolve => gateway.server.listen(0, '127.0.0.1', resolve));
  const address = gateway.server.address(); assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
}
async function register(name: string) {
  const response = await call('/v1/sessions', human, 'POST', { runtime: 'test', cwd: directory, label: name, nativeId: name === 'one' ? 'native-session-1' : `native-${name}` });
  assert.equal(response.status, 201, await response.clone().text());
  const data = await response.json() as { sessionId: string; sessionToken: string; workspaceId: string; branchId: string };
  return { ...data, token: data.sessionToken };
}
async function call(path: string, token?: string, method = 'GET', body?: unknown, extraHeaders: Record<string, string> = {}) {
  return fetch(`${baseUrl}${path}`, { method, headers: { ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function mintTicket() { const response = await call('/v1/console-ticket', human, 'POST'); assert.equal(response.status, 200); return (await response.json() as { ticket: string }).ticket; }
async function exchange(ticket: string) { return call('/v1/console-session', undefined, 'POST', { ticket }); }
