// CLI access to shared state. Writes go through the authorized Core service.
import type { Actor, Session, Workspace } from '../../../packages/contracts/src/index.js';
import { PendingTreeService } from '../../../packages/core/src/index.js';
import { SqliteStore } from '../../../packages/storage/src/index.js';

export class Gateway {
  readonly store: SqliteStore;
  readonly service: PendingTreeService;
  constructor(dbPath: string, readonly actor: Actor) { this.store = new SqliteStore(dbPath); this.service = new PendingTreeService(this.store, actor); }
  close() { this.store.close(); }
  workspaces(): Workspace[] {
    const all = this.store.list<Workspace>('workspace');
    if (this.actor.type === 'human') return all;
    const own = this.store.get<Session>(this.actor.sessionId, 'session'); return all.filter((w) => w.id === own?.workspaceId);
  }
  sessions(workspaceId: string): Session[] { this.service.workspace(workspaceId); return this.store.list<Session>('session').filter((s) => s.workspaceId === workspaceId); }
  agentName(agentId: string): string { return this.store.get<{ name: string }>(agentId, 'agent')?.name ?? agentId; }
}
