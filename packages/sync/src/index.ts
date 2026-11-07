// Public entry for @agentree/sync: scope relevance and session focus.
// Incremental delivery (cursors, levels, budgets) builds on these in later PRs.
export { toRootedPath, parentFolder, type RootedPath } from './paths.js';
export {
  deriveFocus, extractTouches, BASE_WEIGHT,
  type Access, type Touch, type Focus, type FocusEntry, type FocusSource, type FocusDeclaration, type FocusOptions,
} from './focus.js';
export { matchScope, relevance, MATCH_STRENGTH, type MatchKind, type Relevance } from './relevance.js';
