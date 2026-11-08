// Realistic console workflows against the mock Gateway, which follows the
// Main history (docs/MAIN_API.md) and task dispatch (docs/TASK_DISPATCH_API.md) contracts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMock } from './mock.js';
import { diffSnapshots } from '../main-diff.js';
import { taskEvidence } from '../task-status.js';

const setup = async () => {
  const api = createMock({ speed: 0.02 });
  const [{ id: workspaceId }] = await api.workspaces();
  return { api, workspaceId };
};
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('edit Main, restore one entry, then restore a whole historical snapshot', async () => {
  const { api, workspaceId } = await setup();
  const start = await api.main(workspaceId);
  const auth = start.entries.find((e) => e.id === 'main-auth');
  assert.match(auth.body, /30 minutes/);

  // The entry history shows the earlier 15-minute version; restore just that entry.
  const versions = await api.mainHistory(workspaceId, 'main-auth');
  const fifteen = versions.find((v) => /15 minutes/.test(v.body));
  const restored = await api.restoreMainEntry(workspaceId, 'main-auth', { revision: fifteen.revision, expectedRevision: start.revision });
  assert.match(restored.body, /15 minutes/);
  assert.deepEqual(restored.restoredFrom, { revision: fifteen.revision, entryRevision: fifteen.revision });
  assert.equal(restored.revision, start.revision + 1);

  // Add a new entry, then preview and restore the whole Main at revision 2.
  let now = await api.main(workspaceId);
  const added = await api.updateMain(workspaceId, { body: 'Use structured logs', files: [{ rootId: 'app', path: 'src/log.ts' }], expectedRevision: now.revision });
  now = await api.main(workspaceId);
  const preview = await api.mainPreview(workspaceId, 2);
  assert.equal(preview.revision, 2);
  const diff = diffSnapshots(now, preview);
  assert.equal(diff.changes.find((c) => c.id === added.id).kind, 'removed', 'an entry created later is removed by the restore');
  const after = await api.restoreMain(workspaceId, { revision: 2, expectedRevision: now.revision });
  assert.equal(after.revision, now.revision + 1, 'a restore is exactly one new revision');
  assert.ok(after.removedEntries.some((e) => e.id === added.id && e.restoredFrom?.revision === 2));
  const revisions = await api.mainRevisions(workspaceId);
  assert.equal(revisions.at(-1).restoredFromRevision, 2);
  assert.ok(revisions.at(-1).entryIds.includes(added.id));
  // History is kept: the restored-away entry still has all its versions.
  assert.equal((await api.mainHistory(workspaceId, added.id)).length, 2);
});

test('stale revisions, unknown revisions and removed-entry edits are refused without writing', async () => {
  const { api, workspaceId } = await setup();
  const main = await api.main(workspaceId);
  await assert.rejects(() => api.restoreMain(workspaceId, { revision: 1, expectedRevision: main.revision - 1 }),
    (e) => e.code === 'STALE' && e.details.currentRevision === main.revision && e.details.expectedRevision === main.revision - 1);
  await assert.rejects(() => api.mainPreview(workspaceId, main.revision + 5), { code: 'NOT_FOUND' });
  await api.removeMainEntry(workspaceId, 'main-api', { expectedRevision: main.revision });
  const latest = await api.main(workspaceId);
  await assert.rejects(() => api.updateMainEntry(workspaceId, 'main-api', { body: 'x', expectedRevision: latest.revision }), { code: 'STATE' });
  assert.equal((await api.main(workspaceId)).revision, latest.revision, 'nothing was written');
});

test('a task to managed Codex advances only on native turn evidence', async () => {
  const { api, workspaceId } = await setup();
  const task = await api.submitTask({ sessionId: 'session-codex', instructions: 'Add an expiry check to getUser', includeMain: true, requestId: 'req-1' });
  assert.equal(task.status, 'submitted');
  assert.equal(task.mainContext.entries.length, 2, 'Main is snapshotted at submission');
  const done = await until(async () => { const t = await api.task(task.id); return t.status === 'completed' && t; });
  assert.ok(done.nativeTurnId);
  const { events } = await api.events(workspaceId, { after: 0, limit: 1000 });
  const evidence = taskEvidence(done, events).map((e) => e.type);
  for (const type of ['task.submitted', 'task.delivery-pending', 'task.native-accepted', 'turn/started', 'task.running', 'turn/completed', 'task.completed']) assert.ok(evidence.includes(type), type);
  assert.ok(evidence.indexOf('turn/started') < evidence.indexOf('task.running'), 'running follows the native turn/started');
  // Retrying the same request returns the same task; reusing the id for other content is refused.
  assert.equal((await api.submitTask({ sessionId: 'session-codex', instructions: 'Add an expiry check to getUser', includeMain: true, requestId: 'req-1' })).id, task.id);
  await assert.rejects(() => api.submitTask({ sessionId: 'session-codex', instructions: 'Something else', includeMain: true, requestId: 'req-1' }), { code: 'STATE' });
});

test('unavailable agents: Claude CLI is recorded as not deliverable; stopped sessions are refused', async () => {
  const { api } = await setup();
  const claude = await api.submitTask({ sessionId: 'session-claude', instructions: 'Review token.ts', includeMain: false, requestId: 'req-claude' });
  assert.equal(claude.status, 'delivery-unavailable');
  assert.match(claude.reason, /Claude CLI sessions cannot accept unsolicited tasks/);
  const sessions = await api.sessions();
  assert.equal(sessions.find((s) => s.id === 'session-claude').taskDispatch.available, false);
  assert.equal(sessions.find((s) => s.id === 'session-codex').taskDispatch.available, true);

  // A task interrupted mid-run ends as failed with the native reason, not as cancelled.
  const running = await api.submitTask({ sessionId: 'session-codex', instructions: 'Long refactor', includeMain: false, requestId: 'req-long' });
  await until(async () => (await api.task(running.id)).status === 'running');
  assert.equal((await api.cancelTask(running.id)).status, 'cancel-requested');
  const interrupted = await until(async () => { const t = await api.task(running.id); return t.status === 'failed' && t; });
  assert.match(interrupted.reason, /interrupted/);

  // Stopping the session leaves an in-flight task as outcome-unknown and refuses new tasks.
  const inflight = await api.submitTask({ sessionId: 'session-codex', instructions: 'Another change', includeMain: false, requestId: 'req-3' });
  await until(async () => ['native-accepted', 'running'].includes((await api.task(inflight.id)).status));
  await api.killSession('session-codex');
  await until(async () => (await api.task(inflight.id)).status === 'outcome-unknown');
  await assert.rejects(() => api.submitTask({ sessionId: 'session-codex', instructions: 'After stop', includeMain: false, requestId: 'req-4' }), { code: 'DENY' });
});
