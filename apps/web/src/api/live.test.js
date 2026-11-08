// The live client against stubbed fetch: it must not mistake an older Gateway's
// current-Main response for history or a historical preview.
import test from 'node:test';
import assert from 'node:assert/strict';
import { live } from './live.js';

function respond(status, body) {
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const current = { workspaceId: 'w', revision: 7, entries: [], removedEntries: [] };

test('history and preview reject an older Gateway that answers with the current snapshot', async () => {
  respond(200, current);
  await assert.rejects(() => live.mainRevisions('w'), { code: 'UNSUPPORTED' });
  await assert.rejects(() => live.mainPreview('w', 3), { code: 'UNSUPPORTED' });
  respond(200, { ...current, revision: 3 });
  assert.equal((await live.mainPreview('w', 3)).revision, 3);
  respond(200, [{ revision: 1, entryIds: ['a'] }]);
  assert.equal((await live.mainRevisions('w')).length, 1);
});

test('live requests use same-origin paths without pairing credentials', async () => {
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await live.health();
  assert.equal(request.url, '/health');
  assert.equal('credentials' in request.options, false);
  assert.equal(request.options.headers.authorization, undefined);
  assert.equal(live.login, undefined);
  assert.equal(live.logout, undefined);
});

test('local discovery API uses the mock-first contract and same-origin requests', async () => {
  let request;
  globalThis.fetch = async (url, options) => { request = { url, options }; return new Response(JSON.stringify({ refreshedAt: 'now', agents: [] }), { status: 200 }); };
  assert.deepEqual(await live.discoveredAgents(), { refreshedAt: 'now', agents: [] });
  assert.equal(request.url, '/v1/discovery/agents');
  assert.equal(request.options.headers.authorization, undefined);
  await live.refreshDiscovery();
  assert.equal(request.url, '/v1/discovery/refresh');
  assert.equal(request.options.method, 'POST');
});

test('older Gateway lists registered sessions without claiming native process discovery', async () => {
  globalThis.fetch = async url => {
    if (url === '/v1/discovery/agents' || url === '/v1/discovery/refresh') return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Route not found' } }), { status: 404 });
    if (url === '/v1/sessions') return new Response(JSON.stringify([{ id: 's', runtime: 'codex-app-server', workspaceId: 'w', state: 'active', taskDispatch: { available: true } }]));
    if (url === '/v1/workspaces') return new Response(JSON.stringify([{ id: 'w', name: 'project', roots: [{ path: '/repo' }] }]));
    throw new Error(`Unexpected ${url}`);
  };
  const result = await live.discoveredAgents();
  assert.equal(result.source, 'session-registry');
  assert.equal(result.agents[0].process, null);
  assert.equal(result.agents[0].capabilities.canDispatchTasks, true);
  assert.equal((await live.refreshDiscovery()).source, 'session-registry');
});

test('restore on an older Gateway is reported as unsupported; real errors pass through with details', async () => {
  respond(400, { error: { code: 'BODY', message: 'Required' } });
  await assert.rejects(() => live.restoreMain('w', { revision: 1, expectedRevision: 7 }), { code: 'UNSUPPORTED' });
  respond(404, { error: { code: 'NOT_FOUND', message: 'Route not found' } });
  await assert.rejects(() => live.restoreMainEntry('w', 'e', { revision: 1, expectedRevision: 7 }), { code: 'UNSUPPORTED' });
  respond(404, { error: { code: 'NOT_FOUND', message: 'Main revision 99 does not exist' } });
  await assert.rejects(() => live.restoreMain('w', { revision: 99, expectedRevision: 7 }), { code: 'NOT_FOUND' });
  respond(409, { error: { code: 'STALE', message: 'Main changed', details: { expectedRevision: 6, currentRevision: 7 } } });
  await assert.rejects(() => live.restoreMain('w', { revision: 1, expectedRevision: 6 }), (e) => e.code === 'STALE' && e.details.currentRevision === 7);
});
