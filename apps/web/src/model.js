// Loads everything a workspace view needs from the gateway in one place and
// joins it: branches, sessions, merges, reviews and every branch snapshot.
// The gateway has no single-commit endpoint, so commits come from snapshots.
import { api } from './api/index.js';

export async function loadWorkspace(workspace) {
  const [branches, sessions, merges, reviews] = await Promise.all([
    api.branches(workspace.id), api.sessions(), api.merges(), api.reviews(),
  ]);
  const ownMerges = merges.filter((m) => m.workspaceId === workspace.id);
  const mergeIds = new Set(ownMerges.map((m) => m.id));
  const snapshots = Object.fromEntries(await Promise.all(branches.map(async (b) => [b.id, await api.context(b.id)])));
  const commits = new Map();
  for (const snapshot of Object.values(snapshots)) for (const c of snapshot.history) commits.set(c.id, c);
  return {
    workspace,
    branches,
    sessions: sessions.filter((s) => s.workspaceId === workspace.id),
    merges: ownMerges,
    reviews: reviews.filter((r) => mergeIds.has(r.mergeId)),
    snapshots,
    commits,
  };
}

export const branchName = (branches, id) => branches?.find((b) => b.id === id)?.name ?? String(id ?? '').slice(0, 8);

export function sessionLabel(session) {
  if (!session) return 'unknown session';
  return session.label || `${session.runtime} · ${session.nativeId}`;
}

export const findSession = (sessions, id) => sessions?.find((s) => s.id === id);
