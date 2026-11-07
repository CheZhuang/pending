// Per-session delivery ledger: what was selected for a session and whether it
// is pending, delivered or acknowledged. Persisted through A's generic entity
// store (same approach as B's adapter cursors) so no private SQL schema is needed.
import type { Authority } from './authority.js';
import type { FocusDeclaration } from './focus.js';
import type { ContextDelta } from './package.js';

export type DeliveryState = 'pending' | 'delivered' | 'acknowledged';

export interface DeliveryRecord {
  /** `${commitId}:${authority}` — an authority upgrade is a new delivery. */
  itemId: string;
  commitId: string;
  /** Knowledge key, used to follow up on decisions this session already knows. */
  key: string;
  authority: Authority;
  state: DeliveryState;
  /** Relevance score (before authority weighting). */
  score: number;
  attempts: number;
  firstSeenAt: string;
  deliveredAt?: string;
  acknowledgedAt?: string;
}

export interface SessionLedger {
  sessionId: string;
  /** Branch revision tokens + focus at the last full scan; unchanged means idle. */
  fingerprint?: string;
  items: Record<string, DeliveryRecord>;
  /** Prepared but not yet committed batch (adapter push mode). */
  openBatch?: { batchId: string; itemIds: string[] };
  /** Last committed pull response, replayed for a retried requestId. */
  lastPull?: { requestId: string; delta: ContextDelta };
  /** Explicit scope subscription for this session. */
  declaration?: FocusDeclaration;
}

export interface DeliveryLedger {
  load(sessionId: string): SessionLedger;
  save(ledger: SessionLedger): void;
}

export const emptyLedger = (sessionId: string): SessionLedger => ({ sessionId, items: {} });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class MemoryLedger implements DeliveryLedger {
  private readonly data = new Map<string, SessionLedger>();
  load(sessionId: string): SessionLedger {
    const found = this.data.get(sessionId);
    return found ? clone(found) : emptyLedger(sessionId);
  }
  save(ledger: SessionLedger): void {
    this.data.set(ledger.sessionId, clone(ledger));
  }
}

/** Narrow subset of `SqliteStore`; avoids depending on storage internals. */
export interface GenericEntityStore {
  get<T>(id: string): T | undefined;
  put(id: string, kind: string, data: unknown): void;
}

/**
 * SQLite-backed ledger, one `sync_ledger` entity per session. The document
 * deliberately has no top-level workspaceId/branchId fields, which the entity
 * table treats as foreign keys.
 */
export class EntityLedger implements DeliveryLedger {
  constructor(private readonly store: GenericEntityStore) {}
  private id(sessionId: string) {
    return `sync_ledger:${sessionId}`;
  }
  load(sessionId: string): SessionLedger {
    const found = this.store.get<SessionLedger & { id: string }>(this.id(sessionId));
    if (!found || found.sessionId !== sessionId) return emptyLedger(sessionId);
    const { id: _id, ...ledger } = found;
    return ledger;
  }
  save(ledger: SessionLedger): void {
    this.store.put(this.id(ledger.sessionId), 'sync_ledger', { id: this.id(ledger.sessionId), ...ledger });
  }
}

export function countStates(ledger: SessionLedger): Record<DeliveryState, number> {
  const counts: Record<DeliveryState, number> = { pending: 0, delivered: 0, acknowledged: 0 };
  for (const item of Object.values(ledger.items)) counts[item.state] += 1;
  return counts;
}
