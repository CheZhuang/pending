# Codex App Server

The local integration has two layers: `CodexAppServerAdapter` implements the native transport, while `ManagedCodex` binds it to Gateway sessions, MCP, approvals, task delivery, and durable ingestion. User-facing launch examples are in [native setup](../../docs/NATIVE_AGENTS.md).

## Low-level adapter

[CodexAppServerAdapter](src/codex-app-server.ts) starts `codex app-server --listen stdio://`, initializes newline-delimited JSON-RPC, and starts or resumes a trusted thread ID. `startTurn`, `interruptTurn`, and `reconnect` operate on that managed thread; it cannot attach to arbitrary external CLI/Desktop conversations.

Notifications become observed events retaining their method and params. Capabilities declare `managedSession: true`, `contextInjection: false`, and `preExecutionInterception: false`; the adapter alone does not install Agentree context or offer blanket interception.

Server requests are distinguished from responses even when IDs overlap. Without an `onServerRequest` handler, command/file approvals are declined, permission grants are empty, and unsupported requests receive a JSON-RPC error.

## Managed host

[ManagedCodex](src/codex-managed.ts) completes a restricted read-only initialization turn with Agentree MCP disabled, registers the actual native thread with Gateway, and resumes it with session-bound Agentree MCP. It ingests observations, handles supported command/file approval and Agentree MCP elicitation callbacks through Gateway, polls human-submitted tasks, and handles interruption/stop requests. Other tools have no general interception guarantee.

Private registration files retain the connection needed to resume an active session. `resumeFile` reattaches that session after validating Gateway, working directory, and database identity. Normal `close()` ends the Gateway session, so it cannot subsequently resume. Default managed state is `~/.local/share/agentree/native`; override with `stateDirectory`.

## Recovery

The adapter journals observations atomically before ingestion. Its standalone default journal directory is `~/.local/share/agentree/codex-journals`; managed sessions supply a journal under their state directory. SQLite remains the domain source of truth.

Acknowledgment drops delivered journal records only after the Gateway cursor is saved. Unacknowledged events retain IDs across process restarts; new observations receive UUIDs independent of sequence. `initialCursor` continues sequences after restart, and `SqliteCursorStore` persists cursor state. The journal assumes one active owner per thread and cannot recover notifications lost before reaching the adapter.

See [task dispatch](../../docs/TASK_DISPATCH_API.md) for delivery states and uncertain outcomes after interruption or restart.
