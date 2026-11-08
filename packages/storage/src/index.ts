import { randomUUID } from 'node:crypto';
import type { EventPage, EventQuery, SequencedEvent, Workspace, Branch, MainEntry, BranchWork, FileRef } from '../../contracts/src/index.js';
import { DatabaseSync } from 'node:sqlite';

export interface StoredEvent {
  id: string;
  workspaceId: string;
  source: string;
  nativeId: string;
}

/** Synchronous SQLite persistence for Agentree's normalized records. */
export class SqliteStore {
  public readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.migrate();
    this.migrateSupervision();
  }

  private migrate(): void {
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (version > 3) throw new Error('Unsupported database schema version');
    if (version >= 2) return;
    this.transaction(() => {
      if (version === 0) this.db.exec(`
        CREATE TABLE entities (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          data TEXT NOT NULL CHECK(json_valid(data)),
          workspace_ref TEXT GENERATED ALWAYS AS (json_extract(data,'$.workspaceId')) REFERENCES entities(id),
          branch_ref TEXT GENERATED ALWAYS AS (json_extract(data,'$.branchId')) REFERENCES entities(id),
          agent_ref TEXT GENERATED ALWAYS AS (json_extract(data,'$.agentId')) REFERENCES entities(id),
          session_ref TEXT GENERATED ALWAYS AS (json_extract(data,'$.provenance.sessionId')) REFERENCES entities(id),
          source_ref TEXT GENERATED ALWAYS AS (json_extract(data,'$.sourceBranchId')) REFERENCES entities(id),
          target_ref TEXT GENERATED ALWAYS AS (json_extract(data,'$.targetBranchId')) REFERENCES entities(id),
          merge_ref TEXT GENERATED ALWAYS AS (json_extract(data,'$.mergeId')) REFERENCES entities(id) DEFERRABLE INITIALLY DEFERRED,
          review_ref TEXT GENERATED ALWAYS AS (json_extract(data,'$.reviewId')) REFERENCES entities(id) DEFERRABLE INITIALLY DEFERRED
        );
        CREATE TABLE branch_commits (
          branch_id TEXT NOT NULL REFERENCES entities(id),
          commit_id TEXT NOT NULL REFERENCES entities(id),
          revision INTEGER NOT NULL,
          UNIQUE(branch_id, revision),
          PRIMARY KEY(branch_id, commit_id)
        );
        CREATE TRIGGER entity_identity_update BEFORE UPDATE ON entities
        WHEN OLD.kind != NEW.kind OR json_extract(OLD.data,'$.id') != json_extract(NEW.data,'$.id')
          BEGIN SELECT RAISE(ABORT, 'entity identity is immutable'); END;
        CREATE TRIGGER entity_delete BEFORE DELETE ON entities
          BEGIN SELECT RAISE(ABORT, 'entity history cannot be deleted'); END;
        CREATE TRIGGER immutable_commit_update BEFORE UPDATE ON entities WHEN OLD.kind = 'commit'
          BEGIN SELECT RAISE(ABORT, 'commit entities are immutable'); END;
      `);
      if (version === 1) this.db.exec(`
        DROP TRIGGER immutable_event_update;
        DROP TRIGGER immutable_event_delete;
        DROP TRIGGER immutable_commit_delete;
        DROP TRIGGER entity_references_insert;
        ALTER TABLE events RENAME TO events_v1;
      `);
      this.db.exec(`
        CREATE TABLE events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          workspace_id TEXT NOT NULL,
          source TEXT NOT NULL,
          native_id TEXT NOT NULL,
          data TEXT NOT NULL CHECK(json_valid(data)),
          UNIQUE(workspace_id, source, native_id)
        );
        CREATE TRIGGER immutable_event_update BEFORE UPDATE ON events
          BEGIN SELECT RAISE(ABORT, 'events are immutable'); END;
        CREATE TRIGGER immutable_event_delete BEFORE DELETE ON events
          BEGIN SELECT RAISE(ABORT, 'events are immutable'); END;
        CREATE INDEX events_workspace_sequence ON events(workspace_id,sequence);
        CREATE INDEX events_session_sequence ON events(workspace_id,json_extract(data,'$.sessionId'),sequence);
        CREATE INDEX entities_kind_workspace ON entities(kind,workspace_ref);
        CREATE UNIQUE INDEX session_native_identity ON entities(workspace_ref,json_extract(data,'$.runtime'),json_extract(data,'$.nativeId')) WHERE kind='session';
        CREATE TABLE decision_changes (
          branch_id TEXT NOT NULL REFERENCES entities(id),
          revision INTEGER NOT NULL,
          identity TEXT NOT NULL,
          commit_id TEXT REFERENCES entities(id),
          PRIMARY KEY(branch_id,identity,revision)
        );
        CREATE TRIGGER immutable_decision_update BEFORE UPDATE ON decision_changes
          BEGIN SELECT RAISE(ABORT, 'decision history is immutable'); END;
        CREATE TRIGGER immutable_decision_delete BEFORE DELETE ON decision_changes
          BEGIN SELECT RAISE(ABORT, 'decision history is immutable'); END;
      `);
      if (version === 1) this.db.exec(`
        INSERT INTO events(sequence,id,workspace_id,source,native_id,data)
          SELECT rowid,id,workspace_id,source,native_id,data FROM events_v1 ORDER BY rowid;
        DROP TABLE events_v1;
      `);
      // Backfill pre-inheritance workspaces without rewriting any commits or events.
      for (const workspace of this.list<{id:string; mainBranchId?:string}>('workspace')) {
        const main = this.db.prepare("SELECT id FROM entities WHERE kind='branch' AND workspace_ref=? AND json_extract(data,'$.name')='main'").get(workspace.id) as {id:string}|undefined;
        const mainId = main?.id ?? randomUUID();
        if (!main) this.insert(mainId, 'branch', {id:mainId, workspaceId:workspace.id, name:'main', revision:0, restricted:true});
        else {
          const branch = this.get<Record<string,unknown>>(mainId)!;
          this.put(mainId, 'branch', {...branch, restricted:true});
        }
        this.put(workspace.id, 'workspace', {...workspace, mainBranchId:mainId});
        const eventId = randomUUID();
        this.appendEvent({id:eventId,workspaceId:workspace.id,source:'gateway',nativeId:eventId,
          type:'workspace.main-initialized',mode:'controlled',payload:{mainBranchId:mainId,schemaVersion:2},occurredAt:new Date().toISOString()});
      }
      const rows = this.db.prepare(`SELECT bc.branch_id,bc.revision,e.data FROM branch_commits bc
        JOIN entities e ON e.id=bc.commit_id WHERE json_extract(e.data,'$.knowledge.kind')='decision'
        ORDER BY bc.branch_id,bc.revision`).all() as Array<{branch_id:string;revision:number;data:string}>;
      for (const row of rows) {
        const commit = JSON.parse(row.data);
        const scope = commit.knowledge.scope;
        const identity = JSON.stringify(scope.type === 'workspace' ? [commit.knowledge.key, 'workspace']
          : scope.type === 'task' ? [commit.knowledge.key, 'task', scope.taskId]
          : [commit.knowledge.key, scope.type, scope.rootId ?? null, scope.path.replace(/\\/g, '/').split('/').filter((p: string) => p && p !== '.').join('/') || '.']);
        this.recordDecision(row.branch_id,row.revision,identity,commit.id);
      }
      // Legacy reviews did not pin inherited main. Existing nonempty main makes them stale.
      for (const merge of this.list<{id:string;workspaceId:string}>('merge')) {
        const workspace = this.get<{mainBranchId:string}>(merge.workspaceId)!;
        const main = this.get<{revision:number}>(workspace.mainBranchId)!;
        this.put(merge.id,'merge',{...merge,expectedMainRevision:main.revision === 0 ? 0 : -1});
      }
      this.db.exec('PRAGMA user_version = 2');
    });
  }

  /** One-way projection of old knowledge records; original rows remain audit evidence. */
  private migrateSupervision(): void {
    if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version) >= 3) return;
    this.transaction(() => {
      type LegacyCommit = {id:string;workspaceId:string;branchId:string;revision:number;
        knowledge:{kind:string;body:string;scope:{type:string;rootId?:string;path?:string}};
        provenance:{sessionId:string;eventIds:string[]};createdAt:string};
      const commits = this.list<LegacyCommit>('commit');
      const workspaces = this.list<Workspace>('workspace');
      for (const workspace of workspaces) {
        const attachments = this.db.prepare('SELECT commit_id,revision FROM branch_commits WHERE branch_id=? ORDER BY revision')
          .all(workspace.mainBranchId) as Array<{commit_id:string;revision:number}>;
        const acceptedIds = new Set(attachments.map(row => row.commit_id));
        const main = this.get<Branch>(workspace.mainBranchId)!;
        const activeDecisions = new Set(this.decisions<LegacyCommit>(main.id,main.revision).map(c => c.id));
        const filesFor = (commit:LegacyCommit):FileRef[] => {
          const scope = commit.knowledge.scope;
          const rootId = scope.rootId ?? (workspace.roots.length === 1 ? workspace.roots[0]!.id : undefined);
          if (scope.type !== 'file' || !scope.path || !rootId || !workspace.roots.some(r => r.id === rootId)) return [];
          const segments = scope.path.replace(/\\/g,'/').split('/');
          if (scope.path.startsWith('/') || scope.path.startsWith('\\') || /^[A-Za-z]:/.test(scope.path) || segments.includes('..')) return [];
          const path = segments.filter(p => p && p !== '.').join('/');
          return path ? [{rootId,path}] : [];
        };
        for (const commit of commits.filter(c => c.workspaceId === workspace.id && c.branchId !== main.id)) {
          const work:BranchWork = {id:`legacy-work:${commit.id}`,workspaceId:workspace.id,branchId:commit.branchId,
            sessionId:commit.provenance.sessionId,body:commit.knowledge.body,files:filesFor(commit),
            eventIds:[...commit.provenance.eventIds],conflictsWithMain:[],
            state:acceptedIds.has(commit.id) ? 'accepted' : 'proposed',createdAt:commit.createdAt};
          this.insert(work.id,'branch-work',work);
        }
        for (const attachment of attachments) {
          const commit = commits.find(c => c.id === attachment.commit_id);
          if (!commit) continue;
          const entry:MainEntry = {id:`legacy-main:${commit.id}`,workspaceId:workspace.id,
            body:commit.knowledge.body,files:filesFor(commit),revision:attachment.revision,
            removed:commit.knowledge.kind === 'decision' && !activeDecisions.has(commit.id),
            actor:{type:'human',id:'legacy-acceptance'},createdAt:commit.createdAt,legacyCommitId:commit.id,
            ...(commit.branchId !== main.id ? {sourceWorkId:`legacy-work:${commit.id}`} : {})};
          this.insert(entry.id,'main-entry',entry);
          this.insert(`legacy-revision:${commit.id}`,'main-revision',{id:`legacy-revision:${commit.id}`,workspaceId:workspace.id,entry});
        }
        const eventId = randomUUID();
        this.appendEvent({id:eventId,workspaceId:workspace.id,source:'gateway',nativeId:eventId,
          type:'storage.supervision-migrated',mode:'controlled',payload:{from:2,to:3,acceptedEntries:attachments.length,
            note:'Legacy accepted content projected; pending reviews do not confer acceptance. Original provenance retained in legacy commits.'},occurredAt:new Date().toISOString()});
      }
      this.db.exec(`CREATE TRIGGER immutable_main_revision_update BEFORE UPDATE ON entities WHEN OLD.kind = 'main-revision'
        BEGIN SELECT RAISE(ABORT, 'Main revision history is immutable'); END;`);
      this.db.exec('PRAGMA user_version = 3');
    });
  }

  private recordDecision(branchId: string, revision: number, identity: string, commitId: string | null): void {
    this.db.prepare('INSERT INTO decision_changes(branch_id,revision,identity,commit_id) VALUES(?,?,?,?)').run(branchId, revision, identity, commitId);
  }

  private decisions<T>(branchId: string, revision: number): T[] {
    const rows = this.db.prepare(`SELECT e.data FROM (
      SELECT commit_id, ROW_NUMBER() OVER (PARTITION BY identity ORDER BY revision DESC) AS rank
      FROM decision_changes WHERE branch_id=? AND revision<=?
    ) d JOIN entities e ON e.id=d.commit_id WHERE d.rank=1`).all(branchId,revision) as Array<{data:string}>;
    return rows.map(row => JSON.parse(row.data) as T);
  }

  event<T>(id: string): T | undefined {
    const row = this.db.prepare('SELECT data,sequence FROM events WHERE id=?').get(id) as {data:string;sequence:number}|undefined;
    return row ? {...JSON.parse(row.data), sequence:row.sequence} as T : undefined;
  }

  eventPage(workspaceId: string, query: EventQuery = {}): EventPage {
    const after = query.afterSequence ?? 0;
    const through = query.throughSequence ?? Number(this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM events WHERE workspace_id=?').get(workspaceId)!.n);
    const clauses = ['workspace_id=?','sequence>?','sequence<=?'];
    const params: (string|number)[] = [workspaceId,after,through];
    for (const field of ['sessionId','source','type'] as const) {
      if (query[field] !== undefined) {
        clauses.push(field === 'source' ? 'source=?' : `json_extract(data,'$.${field}')=?`);
        params.push(query[field]!);
      }
    }
    const limit = query.limit ?? 100;
    const rows = this.db.prepare(`SELECT data,sequence FROM events WHERE ${clauses.join(' AND ')} ORDER BY sequence LIMIT ?`).all(...params,limit+1) as Array<{data:string;sequence:number}>;
    const hasMore = rows.length > limit;
    const events = rows.slice(0,limit).map(row => ({...JSON.parse(row.data),sequence:row.sequence}) as SequencedEvent);
    return {events, nextSequence:hasMore ? events.at(-1)!.sequence : Math.max(after,through), throughSequence:through, hasMore};
  }

  /** Newest session-associated native/approval events for a logical branch overview. */
  recentSessionEvents(workspaceId: string, sessionIds: string[], limit = 30): SequencedEvent[] {
    if (!sessionIds.length) return [];
    const placeholders = sessionIds.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT data,sequence FROM events WHERE workspace_id=?
      AND json_extract(data,'$.sessionId') IN (${placeholders}) ORDER BY sequence DESC LIMIT ?`)
      .all(workspaceId,...sessionIds,limit) as Array<{data:string;sequence:number}>;
    return rows.map(row => ({...JSON.parse(row.data),sequence:row.sequence}) as SequencedEvent);
  }

  transaction<T>(fn: () => T, write = true): T {
    this.db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }

  get<T>(id: string, kind?: string): T | undefined {
    const row = (kind === undefined
      ? this.db.prepare('SELECT data FROM entities WHERE id=?').get(id)
      : this.db.prepare('SELECT data FROM entities WHERE id=? AND kind=?').get(id,kind)) as {data:string}|undefined;
    return row === undefined ? undefined : JSON.parse(row.data) as T;
  }

  list<T>(kind: string): T[] {
    const rows = this.db.prepare('SELECT data FROM entities WHERE kind = ? ORDER BY rowid').all(kind) as Array<{ data: string }>;
    return rows.map(({ data }) => JSON.parse(data) as T);
  }

  insert(id: string, kind: string, data: unknown): void {
    this.db.prepare('INSERT INTO entities (id, kind, data) VALUES (?, ?, ?)').run(id, kind, JSON.stringify(data));
  }

  put(id: string, kind: string, data: unknown): void {
    const result = this.db.prepare(`
      INSERT INTO entities (id, kind, data) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, data = excluded.data
    `).run(id, kind, JSON.stringify(data));
    void result;
  }

  /** Insert an observed event; returns false when its source identity was seen before. */
  appendEvent<T extends StoredEvent>(event: T): boolean {
    const result = this.db.prepare(`
      INSERT INTO events (id, workspace_id, source, native_id, data)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id, source, native_id) DO NOTHING
    `).run(event.id, event.workspaceId, event.source, event.nativeId, JSON.stringify(event));
    return result.changes > 0;
  }

  events<T = StoredEvent>(): T[] {
    const rows = this.db.prepare('SELECT data,sequence FROM events ORDER BY sequence').all() as Array<{ data: string; sequence: number }>;
    return rows.map(row => ({...JSON.parse(row.data), sequence:row.sequence}) as T);
  }

  close(): void {
    this.db.close();
  }
}
