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
  }

  private migrate(): void {
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (version > 1) throw new Error('Unsupported database schema version');
    if (version === 1) return;
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS entities (
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
        CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          source TEXT NOT NULL,
          native_id TEXT NOT NULL,
          data TEXT NOT NULL,
          UNIQUE(workspace_id, source, native_id)
        );
        CREATE TABLE IF NOT EXISTS branch_commits (
          branch_id TEXT NOT NULL REFERENCES entities(id),
          commit_id TEXT NOT NULL REFERENCES entities(id),
          revision INTEGER NOT NULL,
          UNIQUE(branch_id, revision),
          PRIMARY KEY(branch_id, commit_id)
        );
        CREATE TRIGGER entity_references_insert BEFORE INSERT ON entities BEGIN
          SELECT CASE WHEN json_extract(NEW.data, '$.workspaceId') IS NOT NULL AND NOT EXISTS
            (SELECT 1 FROM entities WHERE id=json_extract(NEW.data, '$.workspaceId') AND kind='workspace')
            THEN RAISE(ABORT, 'workspace reference missing') END;
          SELECT CASE WHEN NEW.kind IN ('session','commit') AND NOT EXISTS
            (SELECT 1 FROM entities WHERE id=json_extract(NEW.data, '$.branchId') AND kind='branch')
            THEN RAISE(ABORT, 'branch reference missing') END;
          SELECT CASE WHEN NEW.kind='session' AND NOT EXISTS
            (SELECT 1 FROM entities WHERE id=json_extract(NEW.data, '$.agentId') AND kind='agent')
            THEN RAISE(ABORT, 'agent reference missing') END;
        END;
        CREATE TRIGGER entity_identity_update BEFORE UPDATE ON entities
        WHEN OLD.kind != NEW.kind OR json_extract(OLD.data,'$.id') != json_extract(NEW.data,'$.id')
        BEGIN SELECT RAISE(ABORT, 'entity identity is immutable'); END;
        CREATE TRIGGER entity_delete BEFORE DELETE ON entities
        BEGIN SELECT RAISE(ABORT, 'entity history cannot be deleted'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_commit_update
          BEFORE UPDATE ON entities WHEN OLD.kind = 'commit'
          BEGIN SELECT RAISE(ABORT, 'commit entities are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_commit_delete
          BEFORE DELETE ON entities WHEN OLD.kind = 'commit'
          BEGIN SELECT RAISE(ABORT, 'commit entities are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_event_update
          BEFORE UPDATE ON events
          BEGIN SELECT RAISE(ABORT, 'events are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_event_delete
          BEFORE DELETE ON events
          BEGIN SELECT RAISE(ABORT, 'events are immutable'); END;
        PRAGMA user_version = 1;
      `);
    });
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }

  get<T>(id: string): T | undefined {
    const row = this.db.prepare('SELECT data FROM entities WHERE id = ?').get(id) as { data: string } | undefined;
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
    const rows = this.db.prepare('SELECT data FROM events ORDER BY rowid').all() as Array<{ data: string }>;
    return rows.map(({ data }) => JSON.parse(data) as T);
  }

  close(): void {
    this.db.close();
  }
}
