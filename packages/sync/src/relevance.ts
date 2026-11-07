// Deterministic relevance matching between a piece of knowledge and a
// session's focus. Relevance only decides what is worth delivering; it never
// grants access, and it never makes a Finding authoritative.
import type { Knowledge, Scope } from '../../contracts/src/index.js';
import type { Focus, FocusEntry } from './focus.js';

/**
 * How a knowledge scope relates to a focus scope:
 * - exact:      same file / same folder / same task
 * - ancestor:   knowledge is about a folder that contains the focus
 * - descendant: knowledge is about something inside the focused folder
 * - root:       knowledge is about a whole root (folder ".") the focus lives in
 * - workspace:  workspace-wide knowledge, or a workspace-wide subscription
 */
export type MatchKind = 'exact' | 'ancestor' | 'descendant' | 'root' | 'workspace';

/** Fixed strengths keep ordering explainable: closer scopes rank higher. */
export const MATCH_STRENGTH: Record<MatchKind, number> = {
  exact: 1,
  ancestor: 0.7,
  descendant: 0.6,
  root: 0.4,
  workspace: 0.3,
};

type Spatial = Extract<Scope, { type: 'file' | 'folder' }>;
const isSpatial = (s: Scope): s is Spatial => s.type === 'file' || s.type === 'folder';

/** `a` contains `b` by path segments ("src" contains "src/x", not "srcx"). */
function contains(folder: string, path: string): boolean {
  return folder === '.' || path === folder || path.startsWith(`${folder}/`);
}

/** Expects scopes already canonicalized by core `normalizeScope`. */
export function matchScope(knowledge: Scope, focus: Scope): MatchKind | undefined {
  if (knowledge.type === 'workspace' || focus.type === 'workspace') return 'workspace';
  if (knowledge.type === 'task' || focus.type === 'task') {
    // No task-to-location mapping exists, so tasks only match the same task.
    return knowledge.type === 'task' && focus.type === 'task' && knowledge.taskId === focus.taskId ? 'exact' : undefined;
  }
  if (!isSpatial(knowledge) || !isSpatial(focus)) return undefined;
  if (knowledge.rootId !== focus.rootId) return undefined; // different roots are disjoint

  if (knowledge.type === focus.type && knowledge.path === focus.path) return 'exact';
  if (knowledge.type === 'folder' && contains(knowledge.path, focus.path)) {
    return knowledge.path === '.' ? 'root' : 'ancestor';
  }
  if (focus.type === 'folder' && contains(focus.path, knowledge.path)) return 'descendant';
  return undefined;
}

export interface Relevance {
  score: number;
  /** Which knowledge scope matched: where it lives, or what it affects. */
  via: 'location' | 'impact';
  match: MatchKind;
  focus: FocusEntry;
}

/** Best match across location and impact scopes; undefined when unrelated. */
export function relevance(knowledge: Knowledge, focus: Focus): Relevance | undefined {
  const candidates: Array<['location' | 'impact', Scope]> = [['location', knowledge.scope]];
  if (knowledge.impactScope) candidates.push(['impact', knowledge.impactScope]);

  let best: Relevance | undefined;
  for (const [via, scope] of candidates) {
    for (const entry of focus.entries) {
      const match = matchScope(scope, entry.scope);
      if (!match) continue;
      const score = round(MATCH_STRENGTH[match] * entry.weight);
      if (!best || score > best.score) best = { score, via, match, focus: entry };
    }
  }
  return best;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
