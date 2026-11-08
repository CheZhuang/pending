// Overview discovery: the Gateway's /v1/processes inventory merged with managed
// sessions. Discovery alone must never look like a supervised agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMock } from './mock.js';
import { buildAgentRows, processLine, sessionCapabilities } from '../discovery.js';

const overview = async (api) => {
  const [inventory, sessions, workspaces] = await Promise.all([api.processes(), api.sessions(), api.workspaces()]);
  return { inventory, sessions, workspaces, rows: buildAgentRows({ inventory, sessions, workspaces }) };
};

test('mock inventory follows the Gateway ProcessInventory contract', async () => {
  const { inventory } = await overview(createMock({ speed: 0.01 }));
  assert.equal(inventory.status, 'ok');
  assert.ok(inventory.scannedAt);
  for (const p of inventory.processes) {
    assert.ok(['claude-code', 'codex'].includes(p.runtime));
    assert.equal(typeof p.pid, 'number');
    assert.equal(p.nativeObservation, 'unavailable');
    // Discovery grants nothing, linked or not.
    assert.deepEqual(Object.values(p.capabilities), [false, false, false, false]);
  }
});

test('managed sessions carry their process and honest controls; unmanaged processes have none', async () => {
  const { rows } = await overview(createMock({ speed: 0.01 }));
  const codex = rows.managed.find((r) => r.session.id === 'session-codex');
  assert.equal(codex.process.pid, 5201);
  assert.equal(codex.workspace.name, 'shop');
  assert.equal(codex.capabilities.tasks.available, true);
  assert.equal(codex.capabilities.stop.available, true);

  const claude = rows.managed.find((r) => r.session.id === 'session-claude');
  assert.equal(claude.capabilities.tasks.available, false, 'Claude CLI sessions cannot receive unsolicited tasks');
  assert.match(claude.capabilities.tasks.note, /cannot receive unsolicited tasks/);
  assert.equal(claude.capabilities.approvals.available, true);

  assert.equal(rows.unmanaged.length, 2);
  for (const row of rows.unmanaged) {
    assert.equal(row.session, null);
    assert.deepEqual(Object.values(row.capabilities).map((c) => c.available), [false, false, false, false]);
  }
  const partial = rows.unmanaged.find((r) => r.process.pid === 7311);
  assert.equal(partial.process.cwd, undefined, 'missing metadata stays missing');
  assert.match(processLine(partial.process), /start time unavailable/);
});

test('Overview works with no workspace: unmanaged processes only, no workspace calls needed', async () => {
  const { rows, workspaces } = await overview(createMock({ speed: 0.01, noWorkspace: true }));
  assert.deepEqual(workspaces, []);
  assert.deepEqual(rows.managed, []);
  assert.ok(rows.unmanaged.length > 0);
  assert.deepEqual(rows.unknownWorkspaceIds, []);
});

test('a stopped session loses its controls and its process leaves the next scan', async () => {
  const api = createMock({ speed: 0.01 });
  await api.killSession('session-codex');
  let { rows } = await overview(api);
  const stopping = rows.managed.find((r) => r.session.id === 'session-codex');
  assert.equal(stopping.session.state, 'kill-requested');
  assert.equal(stopping.capabilities.stop.available, false);
  assert.equal(stopping.capabilities.tasks.available, false);
  await new Promise((r) => setTimeout(r, 40));
  ({ rows } = await overview(api));
  assert.equal(rows.managed.some((r) => r.session.id === 'session-codex'), false);
  assert.equal(rows.ended.length, 1);
  assert.equal(rows.unmanaged.some((r) => r.process.pid === 5201), false);
});

test('a process linked to an ended session is shown as unmanaged, not controllable', () => {
  const inventory = { status: 'ok', processes: [{ id: '1:a', pid: 1, runtime: 'codex', evidence: 'executable-name', identityReliable: true, managedSessionId: 's1', capabilities: {} }] };
  const rows = buildAgentRows({ inventory, sessions: [{ id: 's1', runtime: 'codex-app-server', state: 'ended', workspaceId: 'w' }], workspaces: [{ id: 'w', name: 'w' }] });
  assert.equal(rows.managed.length, 0);
  assert.equal(rows.unmanaged[0].capabilities.stop.available, false);
});

test('unknown runtimes and missing lifecycle fields never claim capabilities', () => {
  const caps = sessionCapabilities({ id: 's', runtime: 'some-new-agent', state: 'active' });
  assert.equal(caps.tasks.available, false);
  assert.match(caps.tasks.note, /no supported task delivery/);
  assert.equal(caps.approvals.available, false);
  const unknownState = sessionCapabilities({ id: 's', runtime: 'codex-app-server' });
  assert.equal(unknownState.stop.available, false);
  assert.equal(unknownState.tasks.available, false);
});

test('sessions in a workspace the Console has not listed are reported for a list refresh', () => {
  const rows = buildAgentRows({ inventory: null, sessions: [{ id: 's', runtime: 'claude-code', state: 'active', workspaceId: 'new' }], workspaces: [] });
  assert.deepEqual(rows.unknownWorkspaceIds, ['new']);
  assert.equal(rows.managed[0].workspace.name, null);
});

test('unavailable enumeration and a disconnected Gateway are explicit', async () => {
  const unavailable = await createMock({ speed: 0.01, discoveryScenario: 'unavailable' }).processes();
  assert.equal(unavailable.status, 'unavailable');
  assert.deepEqual(unavailable.processes, []);
  assert.ok(unavailable.message);
  const offline = createMock({ speed: 0.01, discoveryScenario: 'gateway-disconnected' });
  await assert.rejects(() => offline.processes(), { code: 'NETWORK' });
  await assert.rejects(() => offline.refreshProcesses(), { code: 'NETWORK' });
});
