/** Preserve the user's edit target and starting revision across reactive reloads. */
export function mainWriteTarget({ editingId, editRevision, editWorkspaceId, workspaceId, currentRevision }) {
  if (!editingId) return { entryId: null, expectedRevision: currentRevision };
  if (editWorkspaceId !== workspaceId) throw new Error('Workspace changed during this edit. Start again on the current workspace.');
  return { entryId: editingId, expectedRevision: editRevision };
}
