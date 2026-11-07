# B package interface notes

This package currently depends on the shared contracts and core service directly;
it does not define a second copy of Agentree domain types.

## Available contracts

- `Session`, `NormalizedEvent`, `Actor`, `PolicyDecision`, `Knowledge`, and merge/review models are in `packages/contracts`.
- `ApplicationService` and `AgentreeService` are in `packages/core`.
- `NormalizedEvent.mode` distinguishes `observed` from `controlled`; core ingestion accepts observed events only.
- Core constructs agent identity from a trusted `Actor` binding. Adapter or MCP input must not choose an actor ID.
- Event deduplication currently uses `(workspaceId, source, nativeId)` in SQLite.

## Open integration questions for A/C

1. Where should durable native transcript cursors live, and what API should adapters use to read and atomically advance them?
2. Which daemon API registers native sessions? Core `registerSession` is an administrative operation and requires a branch plus trusted agent identity.
3. What transport/authentication binds an MCP connection to its Agentree session?
4. What is the agreed `context_sync` cursor and delta contract? Current core exposes `context` and `lookup`, not an incremental sync method.
5. What daemon endpoint exposes event ingestion and policy decisions? No Gateway HTTP API exists in this checkout yet.

Until those are agreed, adapters use injected interfaces and in-memory mocks. No private SQLite schema or guessed HTTP routes should be added here.
