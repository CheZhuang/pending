import test from 'node:test';
import assert from 'node:assert/strict';
import { createMock } from './mock.js';
import { eventEvidence } from '../format.js';
import { mainWriteTarget } from '../views/main-write.js';

test('mock Gateway supports Main history, stale writes, work acceptance and conflict review', async () => {
  const api = createMock();
  const [{ id: workspaceId }] = await api.workspaces();

  let main = await api.main(workspaceId);
  assert.equal(main.entries.length, 2);
  const added = await api.updateMain(workspaceId, { body: 'Use structured logs.', files: [{ rootId: 'app', path: 'src/log.ts' }], expectedRevision: main.revision });
  assert.equal(added.revision, main.revision + 1);
  await assert.rejects(() => api.updateMain(workspaceId, { body: 'stale edit', expectedRevision: main.revision }), { code: 'STALE' });

  main = await api.main(workspaceId);
  const original = main.entries[0];
  const before = (await api.mainHistory(workspaceId, original.id)).length;
  await api.updateMainEntry(workspaceId, original.id, { body: 'Updated guidance.', files: original.files, expectedRevision: main.revision });
  const history = await api.mainHistory(workspaceId, original.id);
  assert.equal(history.length, before + 1);
  main = await api.main(workspaceId);
  await api.updateMainEntry(workspaceId, original.id, { body: original.body, files: original.files, expectedRevision: main.revision, remove: true });
  assert.ok((await api.main(workspaceId)).removedEntries.some(entry => entry.id === original.id));

  const supervision = await api.supervision(workspaceId);
  const branch = supervision.branches.find(item => item.branch.id === 'claude-auth');
  await api.mergeWork(branch.branch.id, { workIds: ['work-claude'], decision: 'accepted', expectedMainRevision: supervision.main.revision });
  assert.ok((await api.main(workspaceId)).entries.some(entry => entry.sourceWorkId === 'work-claude'));

  const [conflict] = await api.conflicts(workspaceId);
  const decided = await api.decideConflict(workspaceId, conflict.id, { status: 'confirmed', explanation: 'The implementation changes the documented lifetime.' });
  assert.equal(decided.status, 'confirmed');
});

test('mock Gateway keeps tool approvals and source event modes distinct', async () => {
  const api = createMock();
  const [{ id: workspaceId }] = await api.workspaces();
  const approvals = await api.approvals();
  const pending = approvals.find(item => item.state === 'pending');
  assert.ok(pending);
  await api.decideApproval(pending.id, 'denied', 'Not needed');
  assert.equal((await api.approvals()).find(item => item.id === pending.id).state, 'denied');

  const page = await api.events(workspaceId, { after: 0, limit: 1000 });
  assert.ok(page.events.some(event => event.mode === 'observed' && event.type === 'tool.result'));
  assert.ok(page.events.some(event => event.mode === 'controlled' && event.type === 'tool.pending'));
  assert.equal(eventEvidence({ type: 'tool.pending', mode: 'controlled', source: 'gateway' }), 'Intercepted tool decision');
  assert.equal(eventEvidence({ type: 'tool.pending', mode: 'observed', source: 'codex' }), 'Observed');
});

test('a remotely removed entry makes an in-flight edit fail instead of creating a new Main entry', async () => {
  const api = createMock();
  const [{ id: workspaceId }] = await api.workspaces();
  const snapshot = await api.main(workspaceId);
  const entry = snapshot.entries[0];
  const editTarget = mainWriteTarget({ editingId: entry.id, editRevision: snapshot.revision, editWorkspaceId: workspaceId, workspaceId, currentRevision: snapshot.revision });

  await api.updateMainEntry(workspaceId, entry.id, { body: entry.body, files: entry.files, expectedRevision: snapshot.revision, remove: true });
  const latest = await api.main(workspaceId);
  const target = mainWriteTarget({ editingId: entry.id, editRevision: editTarget.expectedRevision, editWorkspaceId: workspaceId, workspaceId, currentRevision: latest.revision });
  assert.equal(target.entryId, entry.id);
  await assert.rejects(() => api.updateMainEntry(workspaceId, target.entryId, { body: 'in-flight old text', files: entry.files, expectedRevision: target.expectedRevision }), { code: 'STALE' }); // Gateway checks the revision first
  const final = await api.main(workspaceId);
  assert.equal(final.entries.some(item => item.body === 'in-flight old text'), false);
  assert.ok(final.removedEntries.some(item => item.id === entry.id));
});
