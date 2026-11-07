# Codex App Server integration

`CodexAppServerAdapter` uses the local `codex app-server --listen stdio://` process. It initializes over newline-delimited JSON-RPC, then starts a new thread or resumes a thread ID already known to the trusted Agentree launcher. It normalizes App Server notifications into `observed` events.

The adapter reports `managedSession: true` because Agentree starts or resumes the app-server thread. It reports `contextInjection: false` and `preExecutionInterception: false`: this implementation does not yet send Agentree context into turns or route Codex tool approvals through Agentree policy. It cannot attach to or control arbitrary Codex CLI processes started outside this adapter.

Use `startTurn()` to begin work in a managed thread and `interruptTurn()` to interrupt a known turn. On a transport failure, call `reconnect()`; it starts a new app-server process, initializes it, and resumes the same thread. If the Agentree process itself restarts, pass the durable event cursor as `initialCursor` to `resume()` so event sequence numbers continue from the saved position.

The app-server event stream uses opaque notification method names and JSON params. The adapter preserves the method and params in each event payload instead of assuming every notification kind has a fixed shape. Cursor state can be stored with `SqliteCursorStore`, which uses the existing generic entity storage API and does not add a private SQL table.

Protocol references: [Codex App Server – OpenAI Developers](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) describes stdio JSON messages, initialization, `thread/start`, `thread/resume`, `turn/start`, and event notifications. The broader [Codex as a platform article](https://developers.openai.com/blog/codex-as-a-platform) identifies app-server as the managed integration surface.

## Recovery and server requests

Observations are written to an atomic local journal before ingestion. The default path is the user application-data directory under `agentree/codex-journals`; `journalPath` allows a host to select another application-data path. SQLite remains the domain source of truth; the journal is a delivery spool. Acknowledgement removes delivered records only after the Gateway cursor is saved. Unacknowledged records retain their event IDs across process restarts, while each new observation receives a UUID independent of its cursor sequence. The journal assumes one active owner per native thread. It cannot reconstruct notifications lost before they reach the adapter.

App Server requests are distinguished from responses even when their IDs overlap. Without a configured `onServerRequest` handler, command and file-change approvals are declined, permission grants are empty, and unsupported requests receive a JSON-RPC error. A trusted host can provide its own approval handler.
