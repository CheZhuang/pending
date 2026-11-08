// Small supervision rules shared by Branches and Conflicts.

/** Conflicts still waiting on a human (potential) or confirmed and not yet resolved. */
export const OPEN_CONFLICT = new Set(['potential', 'confirmed']);

/** Open conflicts that involve a logical branch. */
export function openConflictsFor(conflicts, branchId) {
  return (conflicts ?? []).filter((c) => OPEN_CONFLICT.has(c.status) && (c.branchIds ?? []).includes(branchId));
}
