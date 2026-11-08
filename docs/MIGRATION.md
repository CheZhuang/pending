# SQLite migration and compatibility

`SqliteStore` migrates automatically when opening the database. Back up the database before upgrading. Migrations are transactional and there is no schema downgrade path.

## Schema version 3

Version 1 first follows the version 2 migration, initializing or adopting Main while preserving native event sequences. Version 2 to 3 projects accepted Main attachments into `main-entry` and `main-revision` records. Accepted findings remain current; superseded decisions become removed historical entries.

Local agent commits become `branch-work`, accepted only when actually attached to Main. Pending legacy merge requests and reviews confer no acceptance. Original immutable commits, events, and legacy tables remain as archival evidence.

Migration retains `legacyCommitId`, source-work links, and existing Main revision values. IDs use `legacy-main:<commitId>` and `legacy-work:<commitId>`. `legacy-acceptance` identifies inherited acceptance without inventing an original reviewer's identity. The retained `Workspace.mainBranchId` identifies the internal revision head; public branch listings exclude it and native sessions cannot bind to it.

The migration runs once. New domain writes use supervision entities. New delivery metadata uses `supervision_ledger`; legacy `sync_ledger` rows and cached replies cannot replay into the new protocol. Removing archival tables would require a separate retention decision.

## Client changes

The old context-commit, knowledge kind/key/scope, merge-request, review, and apply workflow is retired. Update clients to the [Gateway API](GATEWAY_API.md) and current [MCP tools](../packages/mcp/README.md). Restart or refresh native MCP hosts to discover the replacement tool list.

Existing native credentials, observation ingestion, approvals, and lifecycle records remain usable. Main history/restore APIs use immutable version 3 entries without rewriting old history. Historical previews retain the migration's projected state; they cannot reconstruct edits missing from legacy data.
