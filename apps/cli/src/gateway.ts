// The CLI's only door into Agentree state. Every write goes through A's
// AgentreeService (authorized + audited). Listings that the service does not
// expose yet are read-only and run only after an authorized workspace read.
import type {
  Actor, ContextCommit, MergeRequest, Review, Session, Workspace,
} from '../../../packages/contracts/src/index.js';
import { DomainError } from '../../../packages/contracts/src/index.js';
import { AgentreeService } from '../../../packages/core/src/index.js';
import { SqliteStore } from '../../../packages/storage/src/index.js';
import {
  ContextSync, EntityLedger, MemoryLedger, type DeliveryLedger, type SessionLedger,
} from '../../../packages/sync/src/index.js';

/** Lets `relevant` preview a sync without touching the real ledger. */
class PreviewLedger implements DeliveryLedger {
  private readonly overlay = new Map<string, SessionLedger>();
  constructor(private readonly base: DeliveryLedger) {}
  load(sessionId: string): SessionLedger {
    return structuredClone(this.overlay.get(sessionId) ?? this.base.load(sessionId));
  }
  save(ledger: SessionLedger): void {
    this.overlay.set(ledger.sessionId, structuredClone(ledger));
  }
}

export class Gateway {
  readonly store: SqliteStore;
  readonly service: AgentreeService;

  constructor(dbPath: string, readonly actor: Actor) {
    this.store = new SqliteStore(dbPath);
    this.service = new AgentreeService(this.store, actor);
  }

  close(): void {
    this.store.close();
  }

  /** Acting as another identity on the same database (used for `--as <session>`). */
  as(actor: Actor): AgentreeService {
    return new AgentreeService(this.store, actor);
  }

  // ---- Read-only listings. TODO(A): replace with ApplicationService list methods. ----

  workspaces(): Workspace[] {
    const all = this.store.list<Workspace>('workspace');
    if (this.actor.type === 'human') return all;
    const own = this.store.get<Session>(this.actor.sessionId, 'session');
    return all.filter((w) => w.id === own?.workspaceId);
  }

  sessions(workspaceId: string): Session[] {
    this.service.workspace(workspaceId); // authorized read
    return this.store.list<Session>('session').filter((s) => s.workspaceId === workspaceId);
  }

  merges(workspaceId: string): MergeRequest[] {
    this.service.workspace(workspaceId);
    return this.store.list<MergeRequest>('merge').filter((m) => m.workspaceId === workspaceId);
  }

  reviews(workspaceId: string): Array<{ review: Review; merge: MergeRequest }> {
    const merges = new Map(this.merges(workspaceId).map((m) => [m.id, m]));
    return this.store.list<Review>('review')
      .filter((r) => merges.has(r.mergeId))
      .map((review) => ({ review, merge: merges.get(review.mergeId)! }));
  }

  commit(workspaceId: string, commitId: string): ContextCommit {
    this.service.workspace(workspaceId);
    const commit = this.store.get<ContextCommit>(commitId, 'commit');
    if (!commit || commit.workspaceId !== workspaceId) throw new DomainError('NOT_FOUND', commitId);
    return commit;
  }

  agentName(agentId: string): string {
    return this.store.get<{ name: string }>(agentId, 'agent')?.name ?? agentId;
  }

  // ---- Sync ----

  sync(): ContextSync {
    return new ContextSync(this.service, new EntityLedger(this.store));
  }

  /** Same selection as a real sync, but nothing is marked delivered. `fresh` ignores past deliveries. */
  preview(fresh: boolean): ContextSync {
    return new ContextSync(this.service, fresh ? new MemoryLedger() : new PreviewLedger(new EntityLedger(this.store)));
  }
}
