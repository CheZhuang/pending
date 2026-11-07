-- Exact v1 schema fixture, retained to verify upgrades of existing installations.
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
