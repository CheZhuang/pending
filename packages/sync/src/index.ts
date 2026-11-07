// Public entry for @agentree/sync: scope relevance, session focus and
// incremental context delivery.
export { toRootedPath, parentFolder, type RootedPath } from './paths.js';
export {
  deriveFocus, extractTouches, BASE_WEIGHT,
  type Access, type Touch, type Focus, type FocusEntry, type FocusSource, type FocusDeclaration, type FocusOptions,
} from './focus.js';
export { matchScope, relevance, MATCH_STRENGTH, type MatchKind, type Relevance } from './relevance.js';
export { authorityOf, AUTHORITY_RANK, AUTHORITY_WEIGHT, type Authority } from './authority.js';
export {
  MemoryLedger, EntityLedger, emptyLedger, countStates,
  type DeliveryLedger, type DeliveryRecord, type DeliveryState, type SessionLedger, type GenericEntityStore,
} from './ledger.js';
export {
  formatItem, fitBudget, estimateTokens, NOTICE, DEFAULT_BUDGET_TOKENS, DIGEST_BODY_CHARS,
  type Level, type Candidate, type PackagedItem, type ContextDelta,
} from './package.js';
export { ContextSync, type SyncReader, type SyncRequest, type SyncStatus } from './engine.js';
