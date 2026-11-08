import test from 'node:test';
import assert from 'node:assert/strict';
import { createMock } from './mock.js';

test('discovery mock covers unmanaged Claude, managed Codex, multiple instances and missing metadata', async () => {
  const api = createMock();
  const result = await api.discoveredAgents();
  const claude = result.agents.filter(agent => agent.runtime === 'claude-code');
  assert.equal(claude.length, 2);
  assert.equal(claude[0].session, null);
  assert.equal(claude[0].capabilities.canDispatchTasks, false);
  assert.equal(claude[1].process, null);
  const codex = result.agents.find(agent => agent.runtime === 'codex-app-server');
  assert.equal(codex.session.id, 'session-codex');
  assert.equal(codex.activity.evidence, 'native-observed');
  assert.equal(codex.capabilities.canDispatchTasks, true);
});

test('refresh updates its timestamp and reports a process exit', async () => {
  const api = createMock();
  const before = await api.discoveredAgents();
  const after = await api.refreshDiscovery();
  assert.notEqual(after.refreshedAt, before.refreshedAt);
  const exited = after.agents.find(agent => agent.id === 'proc-claude-4102');
  assert.equal(exited.status, 'exited');
  assert.ok(exited.process.exitedAt);
});

test('empty discovery returns a refresh timestamp and no agents', async () => {
  const result = await createMock({ discoveryScenario: 'empty' }).discoveredAgents();
  assert.ok(result.refreshedAt);
  assert.deepEqual(result.agents, []);
});

test('disconnected gateway produces an explicit network error for discovery and refresh', async () => {
  const api = createMock({ discoveryScenario: 'gateway-disconnected' });
  await assert.rejects(() => api.discoveredAgents(), { code: 'NETWORK' });
  await assert.rejects(() => api.refreshDiscovery(), { code: 'NETWORK' });
});
