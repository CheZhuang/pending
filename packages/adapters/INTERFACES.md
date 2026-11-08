# Native integration boundary

Adapters reuse the shared session/event contracts and trusted Core service. Identity comes from the registered native session and its credential; model payloads never choose an actor. Observed events grant no execution or Main authority.

Native observers retain original payloads and map source-native identities into idempotent durable events. Existing cursor stores/journals retry without duplicating ingestion. Claude hooks and Codex App Server notifications provide tool inputs, file changes and runtime results where available. Core reuses rooted file extraction; command strings alone are not parsed into speculative file changes.

The session-bound MCP server revalidates the runtime credential on every call. It exposes supervision retrieval and lightweight work proposals. Context sync delivers current Main snapshots, branch work and targeted corrections, with retrieval/acknowledgment bookkeeping. It does not rank knowledge types, require scopes or execute recovery.

Tool interception remains distinct from observation. The existing pre-execution hooks and native approval requests ask the Gateway for an allow/deny decision; successful approval is not proof of execution. Native completion/failure events remain the source for runtime-reported results.

The Gateway implements authenticated registration, observation, approvals and lifecycle reporting. Main editing and human acceptance/corrections use the [supervision API](../../docs/GATEWAY_API.md). Passive observation offers no correction delivery by itself; configured MCP agents must retrieve updates through their native runtime. See [architecture and limitations](../../docs/ARCHITECTURE.md).
