// End-to-end sync against the real core service and SQLite: scoped delivery,
// filtering, idle polling, authority upgrades, human-resolved conflicts,
// budgets, retries, push delivery, acknowledgements and resumed sessions.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Knowledge, Session } from '../../contracts/src/index.js';
import { AgentreeService } from '../../core/src/index.js';
import { SqliteStore } from '../../storage/src/index.js';
import { ContextSync, EntityLedger, type ContextDelta, type SyncReader } from './index.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'agentree-sync-'));
  const path = join(directory, 'agentree.sqlite');
  const store = new SqliteStore(path);
  const human = new AgentreeService(store, { type: 'human', id: 'reviewer' });
  const workspace = human.createWorkspace('demo', [{ id: 'app', path: '/repo' }]);
  const aliceBranch = human.createBranch(workspace.id, 'alice');
  const bobBranch = human.createBranch(workspace.id, 'bob');
  const alice = human.registerSession(aliceBranch.id, { id: 'agent-alice', name: 'Alice' }, 'claude', 'native-alice');
  const bob = human.registerSession(bobBranch.id, { id: 'agent-bob', name: 'Bob' }, 'codex', 'native-bob');
  const agent = (s: Session) => new AgentreeService(store, { type: 'agent', sessionId: s.id });
  const aliceAgent = agent(alice), bobAgent = agent(bob);

  let n = 0;
  const touch = (s: Session, svc: AgentreeService, tool: string, file: string) => {
    n += 1;
    svc.ingest({ id: `ev-${s.id}-${n}`, workspaceId: workspace.id, source: `${s.runtime}:${s.nativeId}`, nativeId: `${n}`, sessionId: s.id,
      type: 'tool.use', mode: 'observed', payload: { tool_name: tool, tool_input: { file_path: file } }, occurredAt: new Date().toISOString() });
  };
  touch(alice, aliceAgent, 'Edit', '/repo/src/auth/token.ts');
  touch(bob, bobAgent, 'Edit', '/repo/src/api/users.ts');

  // Each agent syncs through its own authorized service; ledgers share the SQLite store.
  const syncFor = (svc: SyncReader, s = store) => new ContextSync(svc, new EntityLedger(s));
  const mergeToMain = (source: string, commitIds: string[], resolve?: (reviewId: string) => void) => {
    const mainRevision = human.contextRevision(workspace.mainBranchId).mainRevision;
    const merge = human.createMerge(source, workspace.mainBranchId, commitIds, mainRevision, mainRevision);
    if (resolve) resolve(merge.reviewId!); else human.resolveReview(merge.reviewId!, 'approved');
    human.applyMerge(merge.id);
    return merge;
  };
  return { directory, path, store, human, workspace, aliceBranch, bobBranch, alice, bob, aliceAgent, bobAgent, syncFor, mergeToMain, touch,
    cleanup: () => { try { store.close(); } catch { /* already closed */ } rmSync(directory, { recursive: true, force: true }); } };
}

const finding = (key: string, body: string, scope: Knowledge['scope'], impactScope?: Knowledge['scope']): Knowledge =>
  ({ kind: 'finding', key, body, scope, ...(impactScope ? { impactScope } : {}) });
const decision = (key: string, body: string, scope: Knowledge['scope'], impactScope?: Knowledge['scope']): Knowledge =>
  ({ kind: 'decision', key, body, scope, ...(impactScope ? { impactScope } : {}) });
const keys = (d: ContextDelta) => d.items.map((i) => `${i.authority}:${i.key}`);

/** Counts snapshot loads to prove idle polls stay cheap. */
function counting(reader: SyncReader) {
  const calls = { snapshot: 0 };
  const wrapped: SyncReader = {
    workspace: (id) => reader.workspace(id),
    branches: (id) => reader.branches(id),
    contextRevision: (id) => reader.contextRevision(id),
    events: (id, q) => reader.events(id, q),
    snapshot: (id, r) => { calls.snapshot += 1; return reader.snapshot(id, r); },
  };
  return { wrapped, calls };
}

test('relevant findings are delivered once, unrelated ones are filtered, idle polls load nothing', () => {
  const f = fixture();
  try {
    f.aliceAgent.publish(f.aliceBranch.id, finding('token-expiry', 'Tokens now expire after 15 minutes', { type: 'file', path: 'src/auth/token.ts' }, { type: 'folder', path: 'src/api' }));
    f.aliceAgent.publish(f.aliceBranch.id, finding('docs-typo', 'Typo in the install guide', { type: 'folder', path: 'docs' }));

    const { wrapped, calls } = counting(f.bobAgent);
    const bobSync = f.syncFor(wrapped);
    const first = bobSync.sync({ session: f.bob });
    assert.deepEqual(keys(first), ['finding:token-expiry']);
    assert.equal(first.items[0].relevance.via, 'impact');
    assert.equal(first.stats.filtered, 1);
    assert.match(first.notice, /not instructions/);
    assert.equal(first.items[0].provenance?.sessionId, f.alice.id);

    const before = calls.snapshot;
    const second = bobSync.sync({ session: f.bob });
    assert.deepEqual(second.items, []);
    assert.equal(calls.snapshot, before, 'idle poll must not load snapshots');
    assert.equal(second.unacknowledged, 1);

    // Authors do not get their own drafts back.
    assert.deepEqual(f.syncFor(f.aliceAgent).sync({ session: f.alice }).items, []);
  } finally { f.cleanup(); }
});

test('a finding merged into main is re-delivered as accepted context to both agents', () => {
  const f = fixture();
  try {
    const commit = f.aliceAgent.publish(f.aliceBranch.id, finding('token-expiry', '15 minutes', { type: 'file', path: 'src/auth/token.ts' }, { type: 'folder', path: 'src/api' }));
    const bobSync = f.syncFor(f.bobAgent), aliceSync = f.syncFor(f.aliceAgent);
    assert.deepEqual(keys(bobSync.sync({ session: f.bob })), ['finding:token-expiry']);

    f.mergeToMain(f.aliceBranch.id, [commit.id]);
    assert.deepEqual(keys(bobSync.sync({ session: f.bob })), ['accepted-finding:token-expiry']);
    assert.deepEqual(keys(aliceSync.sync({ session: f.alice })), ['accepted-finding:token-expiry']);
    assert.deepEqual(bobSync.sync({ session: f.bob }).items, []);
  } finally { f.cleanup(); }
});

test('a human-resolved conflict becomes the shared decision and the old one is superseded', () => {
  const f = fixture();
  try {
    const bobSync = f.syncFor(f.bobAgent), aliceSync = f.syncFor(f.aliceAgent);
    const d1 = f.aliceAgent.publish(f.aliceBranch.id, decision('token-ttl', 'TTL is 15 minutes', { type: 'folder', path: 'src/auth' }, { type: 'folder', path: 'src/api' }));
    f.mergeToMain(f.aliceBranch.id, [d1.id]);
    assert.deepEqual(keys(aliceSync.sync({ session: f.alice })), ['accepted-decision:token-ttl']);
    assert.deepEqual(keys(bobSync.sync({ session: f.bob })), ['accepted-decision:token-ttl']);

    // Bob proposes a conflicting decision in his own folder. Alice works elsewhere, but
    // she relies on token-ttl, so she sees it as a follow-up proposal only.
    const d2 = f.bobAgent.publish(f.bobBranch.id, decision('token-ttl', 'TTL is 60 minutes for API clients', { type: 'folder', path: 'src/api' }));
    const proposal = aliceSync.sync({ session: f.alice });
    assert.deepEqual(keys(proposal), ['proposed-decision:token-ttl']);
    assert.equal(proposal.items[0].relevance.match, 'follow-up');

    f.mergeToMain(f.bobBranch.id, [d2.id], (reviewId) => {
      const review = f.human.review(reviewId);
      assert.equal(review.conflicts.length, 1);
      f.human.resolveReview(reviewId, 'approved', [{ ...review.conflicts[0], selectedCommitId: d2.id }]);
    });

    const aliceAfter = aliceSync.sync({ session: f.alice });
    const bobAfter = bobSync.sync({ session: f.bob });
    // Superseded corrections rank first, then the decision now in force.
    assert.deepEqual(keys(aliceAfter), ['superseded-decision:token-ttl', 'accepted-decision:token-ttl']);
    assert.deepEqual(aliceAfter.items.map((i) => i.commitId), [d1.id, d2.id]);
    assert.deepEqual(keys(bobAfter), ['superseded-decision:token-ttl', 'accepted-decision:token-ttl']);
    assert.deepEqual(bobAfter.items.map((i) => i.commitId), [d1.id, d2.id]);
  } finally { f.cleanup(); }
});

test('token budgets downgrade detail and defer the rest without duplicates', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 6; i++) {
      f.aliceAgent.publish(f.aliceBranch.id, finding(`api-${i}`, 'x'.repeat(600), { type: 'file', path: `src/api/f${i}.ts` }));
    }
    const bobSync = f.syncFor(f.bobAgent);
    const seen: string[] = [];
    let rounds = 0;
    for (;;) {
      const delta = bobSync.sync({ session: f.bob, level: 'full', budgetTokens: 260 });
      rounds += 1;
      if (!delta.items.length) break;
      assert.ok(delta.stats.tokens <= 260);
      seen.push(...delta.items.map((i) => i.key));
      if (delta.items.length && delta.stats.deferred) assert.ok(delta.items.some((i) => i.level !== 'full'));
      assert.ok(rounds < 10);
    }
    assert.equal(rounds > 2, true, 'budget forced several rounds');
    assert.deepEqual([...seen].sort(), ['api-0', 'api-1', 'api-2', 'api-3', 'api-4', 'api-5']);

    const digest = f.syncFor(f.bobAgent, f.store);
    f.aliceAgent.publish(f.aliceBranch.id, finding('api-long', 'y'.repeat(1000), { type: 'file', path: 'src/api/long.ts' }));
    const item = digest.sync({ session: f.bob }).items[0];
    assert.equal(item.level, 'digest');
    assert.equal(item.truncated, true);
    assert.ok(item.body!.length <= 280);
  } finally { f.cleanup(); }
});

test('retried pulls replay the same batch; push leaves items pending until the adapter confirms', async () => {
  const f = fixture();
  try {
    f.aliceAgent.publish(f.aliceBranch.id, finding('one', 'api change', { type: 'folder', path: 'src/api' }));
    const bobSync = f.syncFor(f.bobAgent);
    const first = bobSync.sync({ session: f.bob, requestId: 'req-1' });
    const retry = bobSync.sync({ session: f.bob, requestId: 'req-1' });
    assert.deepEqual(retry, first);
    assert.equal(bobSync.status(f.bob.id).counts.delivered, 1);

    f.aliceAgent.publish(f.aliceBranch.id, finding('two', 'another api change', { type: 'folder', path: 'src/api' }));
    const failed = await bobSync.push({ session: f.bob }, () => { throw new Error('agent offline'); });
    assert.equal(failed.delivered, false);
    assert.equal(bobSync.status(f.bob.id).counts.pending, 1);
    assert.equal(bobSync.commit(f.bob.id, 'stale-batch'), false);

    const ok = await bobSync.push({ session: f.bob }, () => true);
    assert.equal(ok.delivered, true);
    assert.deepEqual(keys(ok.delta), ['finding:two']);
    assert.deepEqual(bobSync.status(f.bob.id).counts, { pending: 0, delivered: 2, acknowledged: 0 });
  } finally { f.cleanup(); }
});

test('acknowledgement is explicit and survives a resumed session; lost context can be re-delivered', () => {
  const f = fixture();
  try {
    f.aliceAgent.publish(f.aliceBranch.id, finding('a', 'api a', { type: 'folder', path: 'src/api' }));
    f.aliceAgent.publish(f.aliceBranch.id, finding('b', 'api b', { type: 'folder', path: 'src/api' }));
    const delta = f.syncFor(f.bobAgent).sync({ session: f.bob });
    assert.equal(delta.items.length, 2);
    const sync = f.syncFor(f.bobAgent);
    assert.equal(sync.acknowledge(f.bob.id, [delta.items[0].itemId, 'unknown']), 1);
    assert.deepEqual(sync.status(f.bob.id).counts, { pending: 0, delivered: 1, acknowledged: 1 });

    // Daemon restart: reopen SQLite; the ledger and cursor fingerprint persist.
    f.store.close();
    const reopened = new SqliteStore(f.path);
    try {
      const bobAgent = new AgentreeService(reopened, { type: 'agent', sessionId: f.bob.id });
      const resumed = new ContextSync(bobAgent, new EntityLedger(reopened));
      assert.deepEqual(resumed.sync({ session: f.bob }).items, []);
      const again = resumed.sync({ session: f.bob, redeliverUnacknowledged: true });
      assert.deepEqual(again.items.map((i) => i.key), delta.items.slice(1).map((i) => i.key));
      assert.equal(resumed.status(f.bob.id).items[again.items[0].itemId].attempts, 2);
    } finally { reopened.close(); }
  } finally { f.cleanup(); }
});

test('explicit subscriptions extend or override inferred focus and trigger a rescan', () => {
  const f = fixture();
  try {
    f.aliceAgent.publish(f.aliceBranch.id, finding('docs', 'install guide moved', { type: 'folder', path: 'docs' }));
    f.aliceAgent.publish(f.aliceBranch.id, finding('api', 'api moved', { type: 'folder', path: 'src/api' }));
    const bobSync = f.syncFor(f.bobAgent);
    assert.deepEqual(keys(bobSync.sync({ session: f.bob })), ['finding:api']);

    bobSync.subscribe(f.bob.id, { mode: 'extend', scopes: [{ type: 'folder', path: 'docs' }] });
    assert.deepEqual(keys(bobSync.sync({ session: f.bob })), ['finding:docs']);

    f.aliceAgent.publish(f.aliceBranch.id, finding('api-2', 'api again', { type: 'folder', path: 'src/api' }));
    bobSync.subscribe(f.bob.id, { mode: 'override', scopes: [{ type: 'folder', path: 'docs' }] });
    const overridden = bobSync.sync({ session: f.bob });
    assert.deepEqual(overridden.items, []);
    assert.equal(overridden.stats.filtered, 2, 'both api findings are unrelated under the override');
  } finally { f.cleanup(); }
});
