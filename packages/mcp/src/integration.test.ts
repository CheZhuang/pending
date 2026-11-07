import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AgentreeService } from '../../core/src/index.js';
import { SqliteStore } from '../../storage/src/index.js';
import { DomainError } from '../../contracts/src/index.js';
import { EntityLedger, type ContextDelta } from '../../sync/src/index.js';
import { createAgentreeMcpServer } from './index.js';

function fixture() {
  const store = new SqliteStore(':memory:');
  const admin = new AgentreeService(store, { type: 'human', id: 'admin' });
  const workspace = admin.createWorkspace('mcp', [{ id: 'root', path: '/project' }]);
  const a = admin.createBranch(workspace.id, 'a');
  const b = admin.createBranch(workspace.id, 'b');
  const session = admin.registerSession(a.id, { id: 'a', name: 'A' }, 'mock', 'a');
  const peerSession = admin.registerSession(b.id, { id: 'b', name: 'B' }, 'mock', 'b');
  const service = new AgentreeService(store, { type: 'agent', sessionId: session.id });
  const peer = new AgentreeService(store, { type: 'agent', sessionId: peerSession.id });
  const connect = async () => {
    const server = createAgentreeMcpServer({ session, service, ledger: new EntityLedger(store) });
    const client = new Client({ name: 'test', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st); await client.connect(ct);
    return {
      client,
      async call(name: string, args: Record<string, unknown>) {
        const result = await client.callTool({ name, arguments: args });
        const output = result.structuredContent as { ok: boolean; data: unknown; error?: { code: string } };
        return { ...output, isError: result.isError };
      },
      async close() { await client.close(); await server.close(); },
    };
  };
  return { store, admin, workspace, a, b, session, service, peer, connect };
}

test('MCP scopes, budgets, retry and acknowledgement persist across reconnection', async () => {
  const f = fixture(); let c = await f.connect();
  try {
    const relevant = f.peer.publish(f.b.id, { kind: 'finding', key: 'relevant', body: 'a'.repeat(3000), scope: { type: 'file', path: 'src/a.ts' } });
    f.peer.publish(f.b.id, { kind: 'finding', key: 'irrelevant', body: 'docs', scope: { type: 'file', path: 'docs/readme.md' } });
    assert.equal((await c.call('context_subscribe', { scopes: [{ type: 'folder', path: 'src' }], mode: 'override' })).ok, true);
    const result = await c.call('context_sync', { requestId: 'one', level: 'full', budgetTokens: 300 });
    assert.equal(result.ok, true);
    const delta = result.data as ContextDelta;
    assert.deepEqual(delta.items.map(item => item.commitId), [relevant.id]);
    assert.ok(delta.stats.tokens <= 300); assert.notEqual(delta.items[0]!.level, 'full');
    assert.equal(delta.items[0]!.authority, 'finding');
    await c.close(); c = await f.connect();
    assert.deepEqual((await c.call('context_sync', { requestId: 'one' })).data, delta);
    const authorizedWorkspace = f.service.workspace.bind(f.service);
    f.service.workspace = () => { throw new DomainError('DENY', 'Session is no longer authorized'); };
    assert.equal((await c.call('context_sync', { requestId: 'one' })).error?.code, 'DENY');
    f.service.workspace = authorizedWorkspace;
    const redelivery = (await c.call('context_sync', { requestId: 'resumed', redeliverUnacknowledged: true })).data as ContextDelta;
    assert.deepEqual(redelivery.items.map(item => item.itemId), delta.items.map(item => item.itemId));
    assert.deepEqual((await c.call('context_acknowledge', { itemIds: delta.items.map(item => item.itemId) })).data, { acknowledged: 1 });
    await c.close(); c = await f.connect();
    assert.equal(((await c.call('context_sync', { requestId: 'idle', redeliverUnacknowledged: true })).data as ContextDelta).items.length, 0);
    assert.equal(new EntityLedger(f.store).load(f.session.id).items[delta.items[0]!.itemId]!.state, 'acknowledged');
  } finally { await c.close(); f.store.close(); }
});

test('MCP delivers own work again when main accepts it, without history-index cursors', async () => {
  const f = fixture(); const c = await f.connect();
  try {
    await c.call('context_subscribe', { scopes: [{ type: 'workspace' }] });
    const commit = f.service.publish(f.a.id, { kind: 'decision', key: 'choice', body: 'accepted', scope: { type: 'workspace' } });
    assert.equal(((await c.call('context_sync', { requestId: 'draft' })).data as ContextDelta).items.length, 0);
    const merge = f.admin.createMerge(f.a.id, f.workspace.mainBranchId, [commit.id], 0);
    f.admin.resolveReview(merge.reviewId!, 'approved'); f.admin.applyMerge(merge.id);
    const delta = (await c.call('context_sync', { requestId: 'accepted' })).data as ContextDelta;
    assert.deepEqual(delta.items.map(item => [item.commitId, item.authority]), [[commit.id, 'accepted-decision']]);
    assert.ok(delta.notice.includes('human-reviewed'));
  } finally { await c.close(); f.store.close(); }
});

test('MCP validates scopes, passes impact/revision contracts, and denies other workspaces', async () => {
  const f = fixture(); const c = await f.connect();
  try {
    const invalid = await c.call('context_subscribe', { scopes: [{ type: 'file', path: '../secret' }] });
    assert.equal(invalid.error?.code, 'SCOPE');
    assert.equal(new EntityLedger(f.store).load(f.session.id).declaration, undefined);
    const token = f.service.contextRevision(f.a.id);
    const published = await c.call('context_publish', { kind: 'finding', key: 'impact', body: 'x', scope: { type: 'file', path: 'src/a.ts' }, impactScope: { type: 'folder', path: 'src' }, expected: token });
    assert.equal(published.ok, true);
    assert.deepEqual(f.service.context(f.a.id)[0]!.knowledge.impactScope, { type: 'folder', path: 'src', rootId: 'root' });
    const stale = await c.call('context_publish', { kind: 'finding', key: 'stale', body: 'x', scope: { type: 'workspace' }, expected: token });
    assert.equal(stale.error?.code, 'STALE');
    const outside = f.admin.createWorkspace('outside');
    const denied = await c.call('context_get', { branchId: outside.mainBranchId });
    assert.equal(denied.ok, false);
    const listed = await c.client.listTools();
    assert.equal(listed.tools.length, 8);
    const badBudget = await c.client.callTool({ name: 'context_sync', arguments: { requestId: 'invalid', budgetTokens: -1 } });
    assert.equal(badBudget.isError, true);
  } finally { await c.close(); f.store.close(); }
});
