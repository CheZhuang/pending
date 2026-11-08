# Native integration boundary

Use the shared session/event contracts and trusted Core service. Identity comes from the registered session and its credential, never model-selected actor or branch arguments.

Observers preserve native payloads and identities. Ingestion binds them to the registered workspace/session, deduplicates retries, and checkpoints durable cursors. Codex uses a local journal as a delivery spool; it is not the domain source of truth. Rooted file extraction consumes structured native evidence rather than guessing writes from command strings.

The configured [MCP host](../mcp/README.md) authenticates each operation, including cached retries, and supplies session-bound reads and work proposals. [Sync](../sync/README.md) handles retrieval and acknowledgment.

Observation, pre-execution decisions, and runtime-reported results remain distinct. See [native controls](../../docs/NATIVE_AGENTS.md#supported-controls), [Claude implementation](CLAUDE_MANAGED.md), and [Codex implementation](CODEX_APP_SERVER.md) for supported interception and failure behavior.
