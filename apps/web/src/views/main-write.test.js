import test from 'node:test';
import assert from 'node:assert/strict';
import { mainWriteTarget } from './main-write.js';

test('an edit keeps its original entry ID and revision after that entry leaves the active list', () => {
  assert.deepEqual(mainWriteTarget({
    editingId: 'entry-1', editRevision: 7, editWorkspaceId: 'workspace-a',
    workspaceId: 'workspace-a', currentRevision: 9,
  }), { entryId: 'entry-1', expectedRevision: 7 });
});

test('an edit cannot silently move to a different workspace', () => {
  assert.throws(() => mainWriteTarget({
    editingId: 'entry-1', editRevision: 7, editWorkspaceId: 'workspace-a',
    workspaceId: 'workspace-b', currentRevision: 9,
  }), /Workspace changed/);
});
