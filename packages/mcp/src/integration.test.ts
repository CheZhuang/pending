import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AgentreeService } from '../../core/src/index.js';
import { SqliteStore } from '../../storage/src/index.js';
import { EntityLedger, type ContextDelta } from '../../sync/src/index.js';
import { createAgentreeMcpServer } from './index.js';

function fixture() {
  const store = new SqliteStore(':memory:'); const human = new AgentreeService(store, { type: 'human', id: 'admin' });
  const workspace = human.createWorkspace('mcp', [{ id: 'root', path: '/project' }]); const a = human.createBranch(workspace.id, 'a'); const b = human.createBranch(workspace.id, 'b');
  const session = human.registerSession(a.id, { id: 'a', name: 'A' }, 'mock', 'a'); const peerSession = human.registerSession(b.id, { id: 'b', name: 'B' }, 'mock', 'b');
  const service = new AgentreeService(store, { type: 'agent', sessionId: session.id }); let authorized = true;
  const connect = async () => {
    const server = createAgentreeMcpServer({ session, service, ledger: new EntityLedger(store), authorize: async () => { if (!authorized) throw new Error('session credential expired'); } });
    const client = new Client({ name: 'test', version: '1' }); const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
    return { client, async call(name: string, args: Record<string, unknown> = {}) { const r = await client.callTool({ name, arguments: args }); return { result: r, data: (r.structuredContent as { data?: unknown })?.data }; }, async close() { await client.close(); await server.close(); } };
  };
  return { store, human, workspace, a, b, session, peerSession, service, connect, expire: () => { authorized = false; }, restore: () => { authorized = true; } };
}

test('MCP retrieves Main snapshots, proposals and branch corrections with durable ack/retry', async () => {
  const f = fixture(); let c = await f.connect();
  try {
    const entry = f.human.editMain(f.workspace.id, { body: 'Preserve request ID', files: [{ rootId: 'root', path: 'src/api.ts' }] }, 0);
    const first = await c.call('context_sync', { requestId: 'one' }); const delta = first.data as ContextDelta;
    assert.equal(delta.items[0]!.kind, 'main'); assert.equal((delta.items[0]!.value as { entries: unknown[] }).entries.length, 1);
    f.human.editMain(f.workspace.id, { body: 'Preserve request ID on success and error', files: [{ rootId: 'root', path: 'src/api.ts' }] }, 1, entry.id);
    const proposed = await c.call('work_propose', { body: 'Updated API response handling', files: [{ rootId: 'root', path: 'src/api.ts' }] });
    assert.equal((proposed.data as { state: string }).state, 'proposed');
    f.human.sendCorrection(f.a.id, 'Retain the response header name from Main.');
    const update = await c.call('context_sync', { requestId: 'two' }); const updateDelta = update.data as ContextDelta;
    assert.ok(updateDelta.items.some(i => i.kind === 'correction'));
    assert.equal(updateDelta.items.find(i => i.kind === 'main')?.itemId, `main:${f.workspace.id}:2`);
    assert.deepEqual((await c.call('context_sync', { requestId: 'two' })).data, updateDelta);
    await c.close(); c = await f.connect();
    const deniedReplay = await c.call('context_sync', { requestId: 'two' }); assert.equal(deniedReplay.result.isError, undefined);
    f.expire(); const denied = await c.call('context_sync', { requestId: 'two' }); assert.equal(denied.result.isError, true);
    f.restore();
    const ids = updateDelta.items.map(i => i.itemId); const ack = await c.call('context_acknowledge', { itemIds: ids }); assert.deepEqual(ack.data, { acknowledged: ids.length });
    assert.equal((await c.client.listTools()).tools.length, 5);
    const got = await c.call('context_get'); assert.ok((got.data as { main: { entries: Array<{ id: string }> } }).main.entries.some(x => x.id === entry.id));
    f.human.editMain(f.workspace.id, { body: 'Preserve request ID on success and error', files: [{ rootId: 'root', path: 'src/api.ts' }] }, 2, entry.id, true);
    const removed = await c.call('context_sync', { requestId: 'three' });
    const removedSnapshot = (removed.data as ContextDelta).items.find(i => i.kind === 'main')?.value as { entries: unknown[]; removedEntries: Array<{ id: string }> };
    assert.equal(removedSnapshot.entries.length, 0); assert.equal(removedSnapshot.removedEntries[0]!.id, entry.id);
  } finally { await c.close(); f.store.close(); }
});

test('agents can propose branch work but the exposed tools do not grant Main write access', async () => {
  const f = fixture(); const c = await f.connect();
  try {
    const tools = (await c.client.listTools()).tools.map(t => t.name);
    assert.deepEqual(tools.sort(), ['context_acknowledge', 'context_get', 'context_sync', 'work_propose', 'workspace_status'].sort());
    const invalid = await c.call('work_propose', { body: 'file path with no root', files: [{ rootId: 'unknown', path: '../secret' }] });
    assert.equal(invalid.result.isError, true);
    assert.equal(f.human.main(f.workspace.id).entries.length, 0);
  } finally { await c.close(); f.store.close(); }
});

test('authenticated MCP readers receive a restored Main snapshot and agents still have no restore tool', async () => {
  const f = fixture(); const c = await f.connect();
  try {
    const entry = f.human.editMain(f.workspace.id, { body: 'temporary decision' }, 0);
    const before = await c.call('context_sync', { requestId: 'before-rollback' });
    assert.ok((before.data as ContextDelta).items.some(item => item.kind === 'main' && item.itemId === `main:${f.workspace.id}:1`));

    const restored = f.human.restoreMain(f.workspace.id, 0, 1);
    assert.equal(restored.revision, 2);
    const sync = await c.call('context_sync', { requestId: 'after-rollback' });
    const delta = sync.data as ContextDelta;
    const mainItem = delta.items.find(item => item.kind === 'main');
    assert.equal(mainItem?.itemId, `main:${f.workspace.id}:2`);
    assert.deepEqual((mainItem?.value as { entries: unknown[]; removedEntries: Array<{ id: string }> }).entries, []);
    assert.deepEqual((mainItem?.value as { removedEntries: Array<{ id: string }> }).removedEntries.map(item => item.id), [entry.id]);

    const context = await c.call('context_get');
    assert.equal((context.data as { main: { revision: number } }).main.revision, 2);
    assert.deepEqual((context.data as { main: { removedEntries: Array<{ id: string }> } }).main.removedEntries.map(item => item.id), [entry.id]);
    const toolNames = (await c.client.listTools()).tools.map(t => t.name);
    assert.equal(toolNames.some(name => /main.*(restore|edit|remove)/i.test(name)), false);
  } finally { await c.close(); f.store.close(); }
});
