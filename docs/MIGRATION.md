# SQLite migration and compatibility

## PendingTree rename

The application is now PendingTree. Use `pendingtree` (or `npm run pendingtree`), the `PENDINGTREE_*` environment variables, and the `@pendingtree/*` package names. Source integrations use `PendingTreeService`, `createPendingTreeMcpServer`, and `servePendingTreeMcp`. The MCP server/configuration key and tool prefix are now `pendingtree` and `mcp__pendingtree__`; sync envelopes use `pendingtree.supervision-delta`.

The default data directory is now `~/.local/share/pendingtree`. To keep using an existing installation's database, CLI selection, and credentials, stop the old Gateway and managed sessions, then set `PENDINGTREE_HOME` to that installation's data directory before restarting. `GATEWAY_DATA_DIR` and `--db` remain supported. Codex adapter state defaults separately to `~/.local/share/pendingtree/native`, independent of `PENDINGTREE_HOME`; integrations that need the previous adapter state directory must pass it explicitly as `ManagedCodex.open({ stateDirectory, ... })`. Standalone Codex journals also use the new default directory. Relaunch managed sessions to obtain the renamed MCP configuration. The rename does not modify the database schema or rewrite existing records.

Update launch scripts and environment settings to the new names, rebuild, and relaunch managed native sessions to regenerate MCP configuration. Browser preferences use new storage keys; run `pendingtree` again to obtain a new Console ticket and cookie. Existing Console sessions and old launch URLs are not reused.

See below for database schema migrations.

`SqliteStore` migrates automatically when opening the database. Back up the database before upgrading. Migrations are transactional and there is no schema downgrade path.

## Schema version 3

Version 1 first follows the version 2 migration, initializing or adopting Main while preserving native event sequences. Version 2 to 3 projects accepted Main attachments into `main-entry` and `main-revision` records. Accepted findings remain current; superseded decisions become removed historical entries.

Local agent commits become `branch-work`, accepted only when actually attached to Main. Pending legacy merge requests and reviews confer no acceptance. Original immutable commits, events, and legacy tables remain as archival evidence.

Migration retains `legacyCommitId`, source-work links, and existing Main revision values. IDs use `legacy-main:<commitId>` and `legacy-work:<commitId>`. `legacy-acceptance` identifies inherited acceptance without inventing an original reviewer's identity. The retained `Workspace.mainBranchId` identifies the internal revision head; public branch listings exclude it and native sessions cannot bind to it.

The migration runs once. New domain writes use supervision entities. New delivery metadata uses `supervision_ledger`; legacy `sync_ledger` rows and cached replies cannot replay into the new protocol. Removing archival tables would require a separate retention decision.

## Client changes

The old context-commit, knowledge kind/key/scope, merge-request, review, and apply workflow is retired. Update clients to the [Gateway API](GATEWAY_API.md) and current [MCP tools](../packages/mcp/README.md). Restart or refresh native MCP hosts to discover the replacement tool list.

Existing native credentials, observation ingestion, approvals, and lifecycle records remain usable. Main history/restore APIs use immutable version 3 entries without rewriting old history. Historical previews retain the migration's projected state; they cannot reconstruct edits missing from legacy data.
