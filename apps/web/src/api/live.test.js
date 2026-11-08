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

test('live requests use same-origin paths and include the HttpOnly Console cookie', async () => {
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await live.health();
  assert.equal(request.url, '/health');
  assert.equal(request.options.credentials, 'include');
  assert.equal(request.options.headers.authorization, undefined);
  assert.equal(live.login, undefined);
  assert.equal(live.logout, undefined);
});

test('launcher fragment ticket is erased before exchange and later requests; SSE includes cookies', async () => {
  const priorWindow = globalThis.window;
  const priorEventSource = globalThis.EventSource;
  const priorFetch = globalThis.fetch;
  const calls = [];
  const fakeWindow = {
    location: { hash: '#agentree-ticket=one-use-secret', pathname: '/', search: '?mode=live' },
    history: { replaceState(_state, _title, path) { fakeWindow.location.hash = ''; fakeWindow.erasedPath = path; } },
  };
  globalThis.window = fakeWindow;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options, hash: fakeWindow.location.hash });
    return new Response(url.endsWith('/v1/console-session') ? '{"ok":true}' : '{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  let eventSource;
  globalThis.EventSource = class { constructor(url, options) { this.close = () => {}; eventSource = { url, options, close: this.close }; } };
  try {
    const { live: freshLive } = await import(`./live.js?auth-test=${Date.now()}`);
    await freshLive.health();
    assert.equal(fakeWindow.erasedPath, '/?mode=live');
    assert.equal(calls[0].url, '/v1/console-session');
    assert.equal(calls[0].hash, '', 'fragment is removed before the ticket is sent');
    assert.equal(calls[0].options.body, JSON.stringify({ ticket: 'one-use-secret' }));
    assert.equal(calls[0].options.credentials, 'include');
    assert.equal(calls[1].options.credentials, 'include');
    const stop = freshLive.stream('workspace', 0, { onEvent() {}, onStatus() {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(eventSource.options.withCredentials, true);
    assert.doesNotMatch(eventSource.url, /one-use-secret/);
    stop();
  } finally {
    globalThis.window = priorWindow;
    globalThis.EventSource = priorEventSource;
    globalThis.fetch = priorFetch;
  }
});

test('local discovery API uses the mock-first contract and same-origin requests', async () => {
  let request;
  globalThis.fetch = async (url, options) => { request = { url, options }; return new Response(JSON.stringify({ refreshedAt: 'now', agents: [] }), { status: 200 }); };
  assert.deepEqual(await live.discoveredAgents(), { refreshedAt: 'now', agents: [] });
  assert.equal(request.url, '/v1/discovery/agents');
  assert.equal(request.options.headers.authorization, undefined);
  assert.equal(request.options.credentials, 'include');
  await live.refreshDiscovery();
  assert.equal(request.url, '/v1/discovery/refresh');
  assert.equal(request.options.method, 'POST');
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
