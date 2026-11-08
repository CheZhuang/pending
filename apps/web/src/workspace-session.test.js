// Workspace switching: state for the selected workspace only, whatever order the
// previous workspace's history pages and SSE frames arrive in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceController } from './workspace-session.js';
import { fakeGateway, history } from './test-gateway.js';

const newState = () => ({
  workspaces: [], workspaceId: null, connection: 'idle', events: [], lastSeq: 0,
  history: { loading: false, loadingOlder: false, error: null, hasOlder: false, cursor: 0 },
  changed: { sessions: 0, context: 0, supervision: 0, approvals: 0, tasks: 0 }, loading: true, fatal: null,
});
const event = (workspaceId, sequence, type = 'tool.call') => ({ id: `${workspaceId}${sequence}`, workspaceId, sequence, type, mode: 'observed', source: 'test', payload: {} });
const setup = (events, options = {}) => {
  const api = fakeGateway(events);
  const state = newState();
  return { api, state, ctl: createWorkspaceController({ api, state, ...options }) };
};

test('rapid switching: a slow history for the previous workspace never lands', async () => {
  const { api, state, ctl } = setup([event('a', 1), event('b', 2), event('a', 3), event('b', 4)]);
  const releaseA = api.hold('a');
  const first = ctl.selectWorkspace('a');
  await ctl.selectWorkspace('b');
  releaseA();
  await first;
  assert.equal(state.workspaceId, 'b');
  assert.deepEqual(state.events.map((e) => e.sequence), [2, 4]);
  assert.equal(state.lastSeq, 4);
  assert.deepEqual(api.streams.map((s) => s.workspaceId), ['b'], 'no stream is ever opened for a');
});

test('switching back and forth ends on the last choice', async () => {
  const { api, state, ctl } = setup([event('a', 1), event('b', 2)]);
  const releaseA = api.hold('a');
  const releaseB = api.hold('b');
  const calls = [ctl.selectWorkspace('a'), ctl.selectWorkspace('b'), ctl.selectWorkspace('a')];
  releaseB(); releaseA();
  await Promise.all(calls);
  assert.equal(state.workspaceId, 'a');
  assert.deepEqual(state.events.map((e) => e.workspaceId), ['a']);
  assert.deepEqual(api.streams.map((s) => s.workspaceId), ['a']);
});

test('old SSE events and status after a switch are ignored, and the old stream is closed', async () => {
  const { api, state, ctl } = setup([event('a', 1), event('b', 2)]);
  await ctl.selectWorkspace('a');
  const streamA = api.streams[0];
  await ctl.selectWorkspace('b');
  assert.equal(streamA.closed, true);
  const before = { ...state.changed };
  streamA.onEvent(event('a', 10, 'session.registered'));
  streamA.onStatus('closed');
  assert.deepEqual(state.events.map((e) => e.sequence), [2]);
  assert.equal(state.lastSeq, 2);
  assert.notEqual(state.connection, 'closed');
  assert.deepEqual(state.changed, before, 'no view reloads for the old workspace');

  const streamB = api.streams[1];
  streamB.onStatus('live');
  streamB.onEvent(event('a', 11)); // wrong workspace on the right stream
  streamB.onEvent(event('b', 12));
  streamB.onEvent(event('b', 12)); // reconnect replay
  assert.equal(state.connection, 'live');
  assert.deepEqual(state.events.map((e) => e.sequence), [2, 12]);
});

test('the stream starts after the newest loaded sequence, even for an empty window', async () => {
  const { api, ctl } = setup([event('a', 7)]);
  await ctl.selectWorkspace('a');
  await ctl.selectWorkspace('empty');
  assert.deepEqual(api.streams.map((s) => [s.workspaceId, s.after]), [['a', 7], ['empty', 0]]);
});

test('"load older" finishing after a switch is dropped', async () => {
  const { api, state, ctl } = setup(history({ workspaceId: 'a', count: 2000 }).concat(event('b', 5000)), { recentTarget: 50 });
  await ctl.selectWorkspace('a');
  assert.equal(state.history.hasOlder, true);
  const release = api.hold('a');
  const older = ctl.loadOlder();
  await ctl.selectWorkspace('b');
  release();
  await older;
  assert.deepEqual(state.events.map((e) => e.sequence), [5000]);
  assert.equal(state.history.loadingOlder, false);
});

test('loading older prepends contiguous history for the same workspace', async () => {
  const { state, ctl } = setup(history({ workspaceId: 'a', count: 3000 }), { recentTarget: 50, olderTarget: 100 });
  await ctl.selectWorkspace('a');
  const firstBefore = state.events[0].sequence;
  await ctl.loadOlder();
  const seqs = state.events.map((e) => e.sequence);
  assert.ok(seqs[0] < firstBefore);
  assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, i) => seqs[0] + i));
  assert.equal(state.history.cursor, seqs[0] - 1);
});

test('live events beyond the cap drop the oldest and mark them loadable again', async () => {
  const { api, state, ctl } = setup([event('a', 1), event('a', 2)], { maxEvents: 3 });
  await ctl.selectWorkspace('a');
  for (const seq of [3, 4, 5]) api.streams[0].onEvent(event('a', seq));
  assert.deepEqual(state.events.map((e) => e.sequence), [3, 4, 5]);
  assert.equal(state.history.hasOlder, true);
  assert.equal(state.history.cursor, 2);
});

test('a history error is shown, opens no stream, and a retry recovers', async () => {
  const { api, state, ctl } = setup([event('a', 1)]);
  const events = api.events;
  api.events = async () => { throw Object.assign(new Error('down'), { code: 'NETWORK' }); };
  await ctl.selectWorkspace('a');
  assert.equal(state.history.error.code, 'NETWORK');
  assert.equal(api.streams.length, 0);
  api.events = events;
  await ctl.selectWorkspace('a');
  assert.equal(state.history.error, null);
  assert.equal(state.events.length, 1);
  assert.equal(api.streams.length, 1);
});

test('boot with no workspace selects nothing and reads no history', async () => {
  const { api, state, ctl } = setup([]);
  await ctl.boot();
  assert.equal(state.workspaceId, null);
  assert.equal(state.loading, false);
  assert.equal(api.calls.length, 0);
  assert.equal(api.streams.length, 0);
});

test('boot keeps a workspace the person picked while the list was loading', async () => {
  const { api, state, ctl } = setup([event('a', 1), event('b', 2)], { storage: { get: () => 'a', set() {} } });
  let release;
  api.workspaces = () => new Promise((r) => { release = () => r([{ id: 'a' }, { id: 'b' }]); });
  const booting = ctl.boot();
  await ctl.selectWorkspace('b');
  release();
  await booting;
  assert.equal(state.workspaceId, 'b');
  assert.deepEqual(state.workspaces.map((w) => w.id), ['a', 'b']);
});

test('refreshing the list selects the first workspace that appears', async () => {
  const { api, state, ctl } = setup([event('w1', 1)]);
  await ctl.boot();
  api.workspaces = async () => [{ id: 'w1', name: 'demo' }];
  await ctl.refreshWorkspaces();
  assert.equal(state.workspaceId, 'w1');
  assert.equal(state.events.length, 1);
});
