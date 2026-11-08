import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { after, before, test } from 'node:test';
import { createGateway } from './gateway.js';

const legacyToken = 'legacy-admin-token-that-is-long-enough-to-pass-validation';
let directory: string;
let database: string;
let gateway: ReturnType<typeof createGateway>;
let baseUrl: string;
let consoleOrigin: string;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agentree-local-first-'));
  database = join(directory, 'gateway.sqlite');
  await startGateway();
});

after(async () => {
  await gateway.close();
  await rm(directory, { recursive: true, force: true });
});

test('local human access works without an admin token; explicit bearer credentials remain agent credentials', async () => {
  const listing = await request('/v1/workspaces');
  assert.equal(listing.status, 200);
  assert.deepEqual(await listing.json(), []);

  const created = await request('/v1/workspaces', { method: 'POST', body: { name: 'local workspace', roots: [] } });
  assert.equal(created.status, 201);
  const workspace = await created.json() as { id: string };
  assert.ok(workspace.id);

  const sessionResponse = await request('/v1/sessions', { method: 'POST', body: { runtime: 'claude-code', cwd: '/tmp/local-first', label: 'test agent' } });
  assert.equal(sessionResponse.status, 201);
  const session = await sessionResponse.json() as { sessionId: string; sessionToken: string; branchId: string };
  assert.ok(session.sessionToken);
  assert.equal((await request('/v1/events', { method: 'POST', body: {} })).status, 403, 'human access cannot forge native activity');

  // Any explicit bearer token selects the agent credential path. The legacy
  // startup option has no administrator authority, even if supplied.
  assert.equal((await request('/v1/workspaces', { token: legacyToken })).status, 401);
  assert.equal((await request('/v1/workspaces', { token: 'invalid-bearer' })).status, 401);
  assert.equal((await request('/v1/events', { method: 'POST', body: {} })).status, 403, 'human access cannot submit agent activity');
  assert.equal((await request('/v1/sessions', { token: session.sessionToken })).status, 403);
  assert.equal((await request(`/v1/branches/${session.branchId}/work`, { token: session.sessionToken })).status, 200);
});

test('browser origins must be local or explicitly configured, and cross-site metadata is rejected', async () => {
  const sameListener = await request('/v1/workspaces', { headers: { origin: baseUrl } });
  assert.equal(sameListener.status, 200);

  const configuredConsole = await request('/v1/workspaces', { headers: { origin: consoleOrigin } });
  assert.equal(configuredConsole.status, 200);
  const browserWrite = await request('/v1/workspaces', { method: 'POST', headers: { origin: consoleOrigin }, body: { name: 'browser workspace', roots: [] } });
  assert.equal(browserWrite.status, 201, 'a configured loopback console origin may write');

  const badHeaders: Array<Record<string, string>> = [
    { origin: 'https://attacker.example' },
    { origin: 'https://attacker.example', host: 'attacker.example' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-origin' },
  ];
  for (const headers of badHeaders) {
    const response = await request('/v1/workspaces', { method: 'POST', headers, body: { name: 'blocked', roots: [] } });
    assert.equal(response.status, 403, `expected rejection for ${JSON.stringify(headers)}`);
  }
  assert.equal(await hostStatus('attacker.example'), 403, 'a hostile Host header is rejected');
});

test('native session credentials survive gateway restart', async () => {
  const created = await request('/v1/sessions', { method: 'POST', body: { runtime: 'codex-app-server', cwd: '/tmp/restart-agent', label: 'persistent agent' } });
  assert.equal(created.status, 201);
  const session = await created.json() as { sessionId: string; sessionToken: string; branchId: string };
  const beforeRestart = await request(`/v1/branches/${session.branchId}/work`, { token: session.sessionToken });
  assert.equal(beforeRestart.status, 200);

  await gateway.close();
  await startGateway();

  const afterRestart = await request(`/v1/branches/${session.branchId}/work`, { token: session.sessionToken });
  assert.equal(afterRestart.status, 200);
  const work = await request(`/v1/branches/${session.branchId}/work`, {
    method: 'POST', token: session.sessionToken,
    body: { body: 'Agent credential remains scoped after restart', files: [] },
  });
  assert.equal(work.status, 201);
  assert.equal((await request('/v1/workspaces')).status, 200, 'local human access remains available after restart');
});

test('the local server serves the Console shell, deep links, and built assets safely', async () => {
  const assets = join(directory, 'console-assets');
  await mkdir(assets, { recursive: true });
  await writeFile(join(assets, 'index.html'), '<!doctype html><title>Local Console</title>');
  await writeFile(join(assets, 'app.js'), 'window.localConsole = true;');
  const staticGateway = createGateway({ database: join(directory, 'static.sqlite'), consoleDirectory: assets });
  const staticUrl = await listenServer(staticGateway.server);
  try {
    const root = await fetch(staticUrl);
    assert.equal(root.status, 200);
    assert.match(await root.text(), /Local Console/);
    const navigationHeaders = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    assert.equal(await rawStatus(staticUrl, navigationHeaders), 200, 'opening the public Console shell from another site is allowed');
    assert.equal(await rawStatus(`${staticUrl}/v1/workspaces`, navigationHeaders), 403, 'navigation headers never bypass API origin checks');
    assert.equal((await fetch(staticUrl, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403, 'cross-site subresource requests remain blocked');
    const deepLink = await fetch(`${staticUrl}/workspaces/example`);
    assert.equal(deepLink.status, 200);
    assert.match(deepLink.headers.get('content-type') ?? '', /text\/html/);
    const script = await fetch(`${staticUrl}/app.js`);
    assert.equal(await script.text(), 'window.localConsole = true;');
    const traversal = await fetch(`${staticUrl}/..%2fsecret.txt`);
    assert.equal(traversal.status, 403);
  } finally {
    await staticGateway.close();
  }
});

async function startGateway() {
  // Legacy adminToken is intentionally supplied to prove it is ignored.
  const legacyOptions = { database, adminToken: legacyToken, consoleOrigins: ['http://localhost:4173'] };
  gateway = createGateway(legacyOptions);
  await new Promise<void>(resolveListen => gateway.server.listen(0, '127.0.0.1', resolveListen));
  const address = gateway.server.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
  consoleOrigin = 'http://localhost:4173';
}

async function request(path: string, options: {
  method?: string;
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
} = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function hostStatus(host: string): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const url = new URL('/v1/workspaces', baseUrl);
    const req = httpRequest({ hostname: url.hostname, port: Number(url.port), path: url.pathname, method: 'GET', headers: { host } }, response => {
      response.resume();
      response.on('end', () => resolveStatus(response.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

async function rawStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const req = httpRequest(url, { method: 'GET', headers }, response => {
      response.resume();
      response.on('end', () => resolveStatus(response.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

async function listenServer(server: ReturnType<typeof createGateway>['server']): Promise<string> {
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
