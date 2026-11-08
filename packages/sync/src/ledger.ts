// Durable per-session delivery bookkeeping; no ranking or scope subscriptions.
export type DeliveryState = 'delivered' | 'acknowledged';
export interface DeliveryRecord {
  itemId: string;
  state: DeliveryState;
  attempts: number;
  firstSeenAt: string;
  deliveredAt?: string;
  acknowledgedAt?: string;
}
export interface SessionLedger {
  sessionId: string;
  items: Record<string, DeliveryRecord>;
  lastPull?: { requestId: string; delta: unknown };
}
export interface DeliveryLedger { load(sessionId: string): SessionLedger; save(ledger: SessionLedger): void; }
export const emptyLedger = (sessionId: string): SessionLedger => ({ sessionId, items: {} });
const clone = <T>(value: T) => JSON.parse(JSON.stringify(value)) as T;
export class MemoryLedger implements DeliveryLedger {
  private data = new Map<string, SessionLedger>();
  load(sessionId: string) { const value = this.data.get(sessionId); return value ? clone(value) : emptyLedger(sessionId); }
  save(ledger: SessionLedger) { this.data.set(ledger.sessionId, clone(ledger)); }
}
export interface GenericEntityStore { get<T>(id: string): T | undefined; put(id: string, kind: string, data: unknown): void; }
export interface CorrectionDeliveryChange { itemId: string; state: DeliveryState; deliveredAt?: string; acknowledgedAt?: string; }
export class EntityLedger implements DeliveryLedger {
  constructor(private readonly store: GenericEntityStore, private readonly onCorrectionChange?: (sessionId: string, changes: CorrectionDeliveryChange[]) => void) {}
  // New identity keeps legacy context ranking rows and cached responses archival.
  private id(sessionId: string) { return `supervision_ledger:${sessionId}`; }
  load(sessionId: string): SessionLedger {
    const found = this.store.get<SessionLedger & { id: string }>(this.id(sessionId));
    if (!found || found.sessionId !== sessionId) return emptyLedger(sessionId);
    const { id: _id, ...ledger } = found; return ledger;
  }
  save(ledger: SessionLedger) {
    const before = this.load(ledger.sessionId);
    this.store.put(this.id(ledger.sessionId), 'supervision_ledger', { id: this.id(ledger.sessionId), ...ledger });
    if (!this.onCorrectionChange) return;
    const changes = Object.values(ledger.items).filter((item) => item.itemId.startsWith('correction:'))
      .filter((item) => JSON.stringify(before.items[item.itemId] ?? null) !== JSON.stringify(item))
      .map(({ itemId, state, deliveredAt, acknowledgedAt }) => ({ itemId, state, ...(deliveredAt ? { deliveredAt } : {}), ...(acknowledgedAt ? { acknowledgedAt } : {}) }));
    if (changes.length) this.onCorrectionChange(ledger.sessionId, changes);
  }
}
export function countStates(ledger: SessionLedger): Record<DeliveryState, number> {
  const counts: Record<DeliveryState, number> = { delivered: 0, acknowledged: 0 };
  for (const item of Object.values(ledger.items)) counts[item.state]++;
  return counts;
}
