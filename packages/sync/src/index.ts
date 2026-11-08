// Public retrieval API. Rooted activity extraction stays available to adapters.
export { toRootedPath, parentFolder, type RootedPath } from './paths.js';
export { extractTouches, type Access, type Touch } from './focus.js';
export {
  MemoryLedger, EntityLedger, emptyLedger, countStates,
  type DeliveryLedger, type DeliveryRecord, type DeliveryState, type SessionLedger, type GenericEntityStore,
} from './ledger.js';
export { ContextSync, type SyncReader, type SyncRequest, type SyncStatus, type ContextDelta, type SyncItem } from './engine.js';
