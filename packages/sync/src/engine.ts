// Incremental, pull-based context sync for one session. Reads context only
// through A's ApplicationService (authorized reads), selects relevant items,
// tracks pending/delivered/acknowledged per session, and packs within a budget.
import { randomUUID } from 'node:crypto';
import type { ContextCommit, Session } from '../../contracts/src/index.js';
import type { ApplicationService } from '../../core/src/index.js';
import { AUTHORITY_RANK, AUTHORITY_WEIGHT, authorityOf, isAccepted, type Authority } from './authority.js';
import { deriveFocus, type Focus, type FocusDeclaration, type FocusOptions } from './focus.js';
import { countStates, type DeliveryLedger, type DeliveryState, type SessionLedger } from './ledger.js';
import { byPriority, DEFAULT_BUDGET_TOKENS, fitBudget, NOTICE, type Candidate, type ContextDelta, type Level } from './package.js';
import { relevance } from './relevance.js';

/** Read-only slice of A's service that sync needs. */
export type SyncReader = Pick<ApplicationService, 'workspace' | 'branches' | 'contextRevision' | 'snapshot' | 'events'>;

export interface SyncRequest {
  session: Session;
  /** Precomputed focus; by default derived from the session's events + stored subscription. */
  focus?: Focus;
  level?: Level;
  budgetTokens?: number;
  /** Re-send delivered-but-unacknowledged items, e.g. after a resumed native session lost its context. */
  redeliverUnacknowledged?: boolean;
}

export interface SyncStatus {
  sessionId: string;
  counts: Record<DeliveryState, number>;
  declaration?: FocusDeclaration;
  items: SessionLedger['items'];
}

type Ledger = SessionLedger;

const round = (n: number) => Math.round(n * 1000) / 1000;
/** Focus identity ignores weights, which shift with every new activity. */
const focusKey = (focus: Focus) => focus.entries.map((e) => JSON.stringify(e.scope)).sort().join('|');

export class ContextSync {
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly focusOptions?: FocusOptions;

  constructor(
    private readonly reader: SyncReader,
    private readonly ledger: DeliveryLedger,
    options: { now?: () => string; newId?: () => string; focus?: FocusOptions } = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? randomUUID;
    this.focusOptions = options.focus;
  }

  /** Persist an explicit scope subscription for a session (extends or overrides inferred focus). */
  subscribe(sessionId: string, declaration: FocusDeclaration | undefined): void {
    const ledger = this.load(sessionId);
    ledger.declaration = declaration;
    ledger.fingerprint = undefined; // force a rescan with the new focus
    this.ledger.save(ledger);
  }

  /** Focus from the session's own observed events plus its stored subscription. */
  focusFor(session: Session): Focus {
    const workspace = this.reader.workspace(session.workspaceId);
    const events = [];
    let page = this.reader.events(workspace.id, { sessionId: session.id, limit: 1000 });
    events.push(...page.events);
    while (page.hasMore) {
      page = this.reader.events(workspace.id, { sessionId: session.id, afterSequence: page.nextSequence, throughSequence: page.throughSequence, limit: 1000 });
      events.push(...page.events);
    }
    const declaration = this.load(session.id).declaration;
    return deriveFocus({ sessionId: session.id, events, roots: workspace.roots, declaration, options: this.focusOptions });
  }

  /**
   * Pull mode: select, package and mark as delivered in one call.
   * Passing the same `requestId` again replays the previous response instead of
   * computing a new one, so a client retry after a lost response loses nothing.
   */
  sync(request: SyncRequest & { requestId?: string }): ContextDelta {
    const ledger = this.load(request.session.id);
    if (request.requestId && ledger.lastPull?.requestId === request.requestId) return ledger.lastPull.delta;
    const delta = this.prepareOn(ledger, request);
    this.commitOn(ledger, delta.batchId);
    if (request.requestId) ledger.lastPull = { requestId: request.requestId, delta };
    this.ledger.save(ledger);
    return delta;
  }

  /** Push mode step 1: select and package; items stay pending until `commit`. */
  prepare(request: SyncRequest): ContextDelta {
    const ledger = this.load(request.session.id);
    const delta = this.prepareOn(ledger, request);
    this.ledger.save(ledger);
    return delta;
  }

  /** Push mode step 2: the adapter confirmed it handed the batch to the agent. */
  commit(sessionId: string, batchId: string): boolean {
    const ledger = this.load(sessionId);
    const ok = this.commitOn(ledger, batchId);
    if (ok) this.ledger.save(ledger);
    return ok;
  }

  /** Optional adapter-driven delivery. A failed or throwing sink leaves items pending. */
  async push(request: SyncRequest, sink: (delta: ContextDelta) => boolean | Promise<boolean>): Promise<{ delivered: boolean; delta: ContextDelta }> {
    const delta = this.prepare(request);
    if (delta.items.length === 0) return { delivered: false, delta };
    let ok = false;
    try { ok = await sink(delta); } catch { ok = false; }
    return { delivered: ok && this.commit(request.session.id, delta.batchId), delta };
  }

  /** Recipient explicitly confirms it has taken the items into account. */
  acknowledge(sessionId: string, itemIds: string[]): number {
    const ledger = this.load(sessionId);
    let count = 0;
    for (const itemId of itemIds) {
      const record = ledger.items[itemId];
      if (record?.state !== 'delivered') continue; // cannot acknowledge what was never delivered
      record.state = 'acknowledged';
      record.acknowledgedAt = this.now();
      count += 1;
    }
    if (count) this.ledger.save(ledger);
    return count;
  }

  status(sessionId: string): SyncStatus {
    const ledger = this.load(sessionId);
    return { sessionId, counts: countStates(ledger), declaration: ledger.declaration, items: ledger.items };
  }

  private load(sessionId: string): Ledger {
    return this.ledger.load(sessionId);
  }

  private prepareOn(ledger: Ledger, request: SyncRequest): ContextDelta {
    const { session } = request;
    const level = request.level ?? 'digest';
    const budgetTokens = request.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
    const focus = request.focus ?? this.focusFor(session);
    const workspace = this.reader.workspace(session.workspaceId);
    const branches = this.reader.branches(workspace.id);
    const fingerprint = JSON.stringify([branches.map((b) => [b.id, this.reader.contextRevision(b.id)]), focusKey(focus)]);

    const hasPending = Object.values(ledger.items).some((r) => r.state === 'pending');
    let selected: Candidate[] = [];
    let filtered = 0;
    // Idle poll: nothing changed and nothing waiting → no snapshot loads at all.
    if (fingerprint !== ledger.fingerprint || hasPending || request.redeliverUnacknowledged) {
      const scan = this.scan(session, focus, workspace.mainBranchId, branches.map((b) => b.id), ledger);
      filtered = scan.filtered;
      // Pending items that are no longer relevant (focus moved, authority changed) are withdrawn.
      for (const [itemId, record] of Object.entries(ledger.items)) {
        if (record.state === 'pending' && !scan.candidates.has(itemId)) delete ledger.items[itemId];
      }
      for (const candidate of scan.candidates.values()) {
        const record = ledger.items[candidate.itemId];
        if (!record) {
          ledger.items[candidate.itemId] = {
            itemId: candidate.itemId, commitId: candidate.commit.id, key: candidate.commit.knowledge.key, authority: candidate.authority,
            state: 'pending', score: candidate.relevance.score, attempts: 0, firstSeenAt: this.now(),
          };
        } else if (record.state === 'pending') record.score = candidate.relevance.score;
        const current = ledger.items[candidate.itemId];
        if (current.state === 'pending' || (request.redeliverUnacknowledged && current.state === 'delivered')) selected.push(candidate);
      }
      ledger.fingerprint = fingerprint;
    }

    selected = selected.sort(byPriority);
    const { items, deferred, tokens } = fitBudget(selected, level, budgetTokens);
    const batchId = this.newId();
    ledger.openBatch = { batchId, itemIds: items.map((i) => i.itemId) };
    const counts = countStates(ledger);
    return {
      kind: 'agentree.context-delta',
      sessionId: session.id,
      batchId,
      level,
      notice: NOTICE,
      items,
      stats: { candidates: selected.length, filtered, deferred: deferred.length, tokens, budgetTokens },
      unacknowledged: counts.delivered,
    };
  }

  private commitOn(ledger: Ledger, batchId: string): boolean {
    if (ledger.openBatch?.batchId !== batchId) return false;
    for (const itemId of ledger.openBatch.itemIds) {
      const record = ledger.items[itemId];
      if (!record) continue;
      if (record.state === 'pending') record.state = 'delivered';
      if (record.state === 'delivered') record.deliveredAt = this.now();
      record.attempts += 1;
    }
    ledger.openBatch = undefined;
    return true;
  }

  /** Every visible commit at its highest authority, kept only if relevant to the focus. */
  private scan(session: Session, focus: Focus, mainId: string, branchIds: string[], ledger: Ledger) {
    const best = new Map<string, Candidate>();
    const unrelated = new Set<string>();

    // Collect every visible commit first, so "decisions this session authored" is known up front.
    const seen: Array<{ commit: ContextCommit; seenOn: string; authority: Authority }> = [];
    const main = this.reader.snapshot(mainId);
    const inForce = new Set(main.knowledge.map((c) => c.id));
    for (const entry of main.entries) seen.push({ commit: entry.commit, seenOn: mainId, authority: authorityOf(entry.commit, true, inForce.has(entry.commit.id)) });
    for (const branchId of branchIds) {
      if (branchId === mainId) continue;
      for (const entry of this.reader.snapshot(branchId).entries) {
        // Inherited main entries were handled above; only local drafts here.
        if (entry.branchId === branchId) seen.push({ commit: entry.commit, seenOn: branchId, authority: authorityOf(entry.commit, false) });
      }
    }
    const isOwn = (c: ContextCommit) => c.provenance.sessionId === session.id;
    // A replacement inherits how relevant the session's own decision with that key was.
    const ownDecisionScore = new Map<string, number>();
    for (const { commit } of seen) {
      if (!isOwn(commit) || commit.knowledge.kind !== 'decision') continue;
      const score = relevance(commit.knowledge, focus)?.score ?? 0.5;
      ownDecisionScore.set(commit.knowledge.key, Math.max(score, ownDecisionScore.get(commit.knowledge.key) ?? 0));
    }
    const followUp = { via: 'location', match: 'follow-up' } as const;

    const consider = (commit: ContextCommit, seenOn: string, authority: Authority) => {
      const own = isOwn(commit);
      // Own drafts are not news; own work becoming accepted or superseded is.
      if (own && !isAccepted(authority) && authority !== 'superseded-decision') return;
      const itemId = `${commit.id}:${authority}`;
      let match: Candidate['relevance'] | undefined = relevance(commit.knowledge, focus);
      if (authority === 'superseded-decision') {
        // Tell the author, and sessions that were previously told the decision was accepted.
        const prior = ledger.items[`${commit.id}:accepted-decision`];
        if (!own && (!prior || prior.state === 'pending')) return;
        match = match ?? { ...followUp, score: prior?.score ?? ownDecisionScore.get(commit.knowledge.key) ?? 0.5 };
      } else if (!match && (authority === 'accepted-decision' || authority === 'proposed-decision')) {
        // Competing proposals and replacements for a decision this session knows or wrote are relevant to it.
        const known = Object.values(ledger.items).find((r) => r.authority === 'accepted-decision' && r.key === commit.knowledge.key && r.state !== 'pending');
        if (known) match = { ...followUp, score: known.score };
        else if (ownDecisionScore.has(commit.knowledge.key)) match = { ...followUp, score: ownDecisionScore.get(commit.knowledge.key)! };
      }
      if (!match) { unrelated.add(commit.id); return; }
      const candidate: Candidate = { itemId, commit, seenOn, authority, relevance: match, priority: round(match.score * AUTHORITY_WEIGHT[authority]) };
      const previous = best.get(commit.id);
      if (!previous || AUTHORITY_RANK[authority] > AUTHORITY_RANK[previous.authority]) best.set(commit.id, candidate);
    };

    for (const s of seen) consider(s.commit, s.seenOn, s.authority);

    const candidates = new Map([...best.values()].map((c) => [c.itemId, c]));
    const filtered = [...unrelated].filter((id) => !best.has(id)).length;
    return { candidates, filtered };
  }
}
