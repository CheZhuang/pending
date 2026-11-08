// Pull-based retrieval for supervised agent work. Main is always authoritative;
// branch work is visible as unapproved input. This layer does no text ranking.
import type { BranchWork, Conflict, Correction, MainSnapshot, Session, SupervisionContext } from '../../contracts/src/index.js';
import type { ApplicationService } from '../../core/src/index.js';
import { countStates, type DeliveryLedger, type DeliveryState, type SessionLedger } from './ledger.js';

export type SyncReader = Pick<ApplicationService, 'supervision'>;
export interface SyncRequest {
  session: Session;
  limit?: number;
  redeliverUnacknowledged?: boolean;
}
export interface SyncItem<T> {
  itemId: string;
  kind: 'main' | 'work' | 'correction' | 'conflict';
  value: T;
}
export interface ContextDelta {
  kind: 'pendingtree.supervision-delta';
  sessionId: string;
  notice: string;
  items: Array<SyncItem<MainSnapshot | BranchWork | Correction | Conflict>>;
  mainRevision: number;
  stats: { available: number; delivered: number; deferred: number };
  unacknowledged: number;
}
export interface SyncStatus {
  sessionId: string;
  counts: Record<DeliveryState, number>;
  items: SessionLedger['items'];
}
const itemKey = (kind: SyncItem<unknown>['kind'], id: string) => `${kind}:${id}`;

export class ContextSync {
  constructor(private readonly reader: SyncReader, private readonly ledger: DeliveryLedger) {}

  sync(request: SyncRequest & { requestId?: string }): ContextDelta {
    const ledger = this.ledger.load(request.session.id);
    // Authorize the workspace read even when returning a cached retry response.
    const view: SupervisionContext = this.reader.supervision(request.session.workspaceId);
    if (request.requestId && ledger.lastPull?.requestId === request.requestId) return ledger.lastPull.delta as ContextDelta;
    // One current Main snapshot per revision means edits and removals replace the
    // agent's prior Main view atomically, with no keyword matching or ranking.
    const all: Array<SyncItem<MainSnapshot | BranchWork | Correction | Conflict>> = [
      { itemId: itemKey('main', `${view.main.workspaceId}:${view.main.revision}`), kind: 'main', value: view.main },
    ];
    // Corrections are addressed to a branch and only delivered to sessions on it.
    const ownBranch = view.branches.find((b) => b.branch.id === request.session.branchId);
    for (const correction of ownBranch?.corrections ?? []) all.push({ itemId: itemKey('correction', correction.id), kind: 'correction', value: correction });
    for (const conflict of view.conflicts) all.push({ itemId: itemKey('conflict', `${conflict.id}:${conflict.status}:${conflict.updatedAt ?? ''}`), kind: 'conflict', value: conflict });
    for (const branch of view.branches) if (branch.branch.id !== request.session.branchId) for (const work of branch.work) {
      all.push({ itemId: itemKey('work', `${work.id}:${work.state}`), kind: 'work', value: work });
    }

    const maximum = Math.max(1, Math.min(request.limit ?? 100, 500));
    const unacknowledged = Object.values(ledger.items).filter((r) => r.state === 'delivered').length;
    const candidates = all.filter((item) => {
      const old = ledger.items[item.itemId];
      return !old || (request.redeliverUnacknowledged && old.state === 'delivered');
    });
    const selected = candidates.slice(0, maximum);
    for (const item of selected) {
      const prior = ledger.items[item.itemId];
      if (!prior) ledger.items[item.itemId] = { itemId: item.itemId, state: 'delivered', attempts: 0, firstSeenAt: new Date().toISOString() };
      const rec = ledger.items[item.itemId]!;
      rec.state = 'delivered'; rec.deliveredAt = new Date().toISOString(); rec.attempts += 1;
    }
    const delta: ContextDelta = {
      kind: 'pendingtree.supervision-delta', sessionId: request.session.id,
      notice: 'Main is the current human-governed reference and each Main item replaces the prior Main snapshot. Branch work is proposed evidence; corrections are human messages. Retrieval and acknowledgement do not prove an agent followed guidance.',
      items: selected, mainRevision: view.main.revision,
      stats: { available: all.length, delivered: selected.length, deferred: Math.max(0, candidates.length - selected.length) },
      unacknowledged,
    };
    if (request.requestId) ledger.lastPull = { requestId: request.requestId, delta };
    this.ledger.save(ledger);
    return delta;
  }

  /** Corrections available to a managed host notification channel. These are
   * deliberately separate from MCP context retrieval and only mark delivered
   * after the host confirms that its native runtime accepted the notification. */
  pendingCorrections(session: Session): Array<{ itemId: string; value: Correction }> {
    const view = this.reader.supervision(session.workspaceId);
    const ownBranch = view.branches.find((branch) => branch.branch.id === session.branchId);
    const ledger = this.ledger.load(session.id);
    return (ownBranch?.corrections ?? []).flatMap((value) => {
      const itemId = itemKey('correction', value.id);
      return ledger.items[itemId] ? [] : [{ itemId, value }];
    });
  }

  correctionItemIds(session: Session): string[] {
    const view = this.reader.supervision(session.workspaceId);
    const ownBranch = view.branches.find((branch) => branch.branch.id === session.branchId);
    return (ownBranch?.corrections ?? []).map(correction => itemKey('correction', correction.id));
  }

  markCorrectionsDelivered(sessionId: string, itemIds: string[]): number {
    const ledger = this.ledger.load(sessionId);
    let count = 0;
    for (const itemId of itemIds) {
      if (!itemId.startsWith('correction:')) continue;
      const prior = ledger.items[itemId];
      if (prior) continue;
      ledger.items[itemId] = { itemId, state: 'delivered', attempts: 1, firstSeenAt: new Date().toISOString(), deliveredAt: new Date().toISOString() };
      count++;
    }
    if (count) this.ledger.save(ledger);
    return count;
  }

  acknowledge(sessionId: string, itemIds: string[]): number {
    const ledger = this.ledger.load(sessionId); let count = 0;
    for (const id of itemIds) { const item = ledger.items[id]; if (item?.state === 'delivered') { item.state = 'acknowledged'; item.acknowledgedAt = new Date().toISOString(); count++; } }
    if (count) this.ledger.save(ledger);
    return count;
  }
  status(sessionId: string): SyncStatus {
    const ledger = this.ledger.load(sessionId); return { sessionId, counts: countStates(ledger), items: ledger.items };
  }
}
