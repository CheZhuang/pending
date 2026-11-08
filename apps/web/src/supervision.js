// Small supervision rules shared by Branches and Conflicts.

/** Conflicts still waiting on a human (potential) or confirmed and not yet resolved. */
export const OPEN_CONFLICT = new Set(['potential', 'confirmed']);

/** Open conflicts that involve a logical branch. */
export function openConflictsFor(conflicts, branchId) {
  return (conflicts ?? []).filter((c) => OPEN_CONFLICT.has(c.status) && (c.branchIds ?? []).includes(branchId));
}

/**
 * Warnings shown before accepting work. The Gateway reports them per proposal
 * (acceptanceWarnings) and refuses an accept with unresolved conflicts unless the
 * human overrides. Older Gateways report nothing: fall back to the branch's open conflicts.
 */
export function acceptanceWarningsOf(work, conflicts) {
  const reported = work?.acceptanceWarnings;
  if (reported) {
    return { unresolvedConflictIds: reported.unresolvedConflictIds ?? [], overlappingMainEntryIds: reported.overlappingMainEntryIds ?? [], fromGateway: true };
  }
  return { unresolvedConflictIds: openConflictsFor(conflicts, work?.branchId).map((c) => c.id), overlappingMainEntryIds: [], fromGateway: false };
}
