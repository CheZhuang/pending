# Local Gateway API

The Gateway is a local boundary around Agentree Core and SQLite. It binds to `127.0.0.1`; it is intended for a local Console or managed agent launcher, not direct public exposure.

## Start it

Use Node.js 24 or newer:

```sh
npm ci
npm run build
npm start
```

By default it listens at `http://127.0.0.1:8787` and stores data in `~/.local/share/agentree/`. Set `PORT` to change the port and `GATEWAY_DATA_DIR` to change the data directory. On first start the process creates `~/.local/share/agentree/admin-token` (or the corresponding file in `GATEWAY_DATA_DIR`) with restrictive file permissions. Supply `HARNESS_ADMIN_TOKEN` to use a pre-provisioned token instead. Admin tokens must have at least 32 characters. The launcher reads `HARNESS_ADMIN_TOKEN` for session registration. Treat the admin token as a local human credential; do not put it in browser code.

The HTTP API accepts admin/session bearer credentials. `GET /health` is public. The Console can connect directly: set `GATEWAY_CONSOLE_ORIGINS` to a comma-separated exact origin allowlist (defaults to `http://localhost:5173,http://127.0.0.1:5173`). Origins outside this list are rejected. No wildcard CORS is used.

From an allowed origin, `POST /v1/console/login` with the admin bearer pairs the browser for eight hours using an HttpOnly, SameSite=Strict cookie. Subsequent fetch calls use `credentials: 'include'`, and SSE uses `new EventSource(url, {withCredentials:true})`. Browser writes require the paired Origin. `POST /v1/console/logout` revokes the cookie. Browser credentials are memory-only and expire on daemon restart. Keep Console and Gateway on the same hostname (ports may differ) so SameSite cookies work; use localhost for both or 127.0.0.1 for both. Enter the admin token during pairing; do not embed it in frontend source or localStorage. Session bearer credentials cannot pair a browser.
## Credentials and actors

`POST /v1/sessions` requires the admin bearer. Its response includes `sessionId`, `sessionToken`, and `seq`. Keep the session token private to that managed process. The Claude launcher sends it as bearer authentication to stream and end routes and places it in the spawned Claude process as `HARNESS_SESSION_TOKEN`; the pre-tool hook sends it to `/v1/decide`. Do not expose it to the Console UI.

An agent session token is scoped to its own active session. It cannot create workspaces or sessions, list/administer approvals, approve or deny approvals, or kill sessions. Those operations require the admin token. A kill request revokes agent operation permissions immediately; the session credential can still consume its lifecycle stream and report exit via `/end`. Ended credentials cannot perform agent operations.

## Endpoints

JSON request bodies are limited to 1 MiB. Responses use JSON and `Cache-Control: no-store`, except the event stream. Fields marked optional may be omitted. IDs and timestamps are returned in the stored Core model shape in addition to fields called out below.

| Method and path | Credential | Request | Response |
| --- | --- | --- | --- |
| `GET /health` | None | — | `{"status":"ok"}` |
| `POST /v1/console/login` | Admin bearer + allowed Origin | — | HttpOnly Console cookie, `{"ok":true}` |
| `POST /v1/console/logout` | Console cookie + paired Origin | — | Revokes cookie, `{"ok":true}` |
| `GET /v1/workspaces` | Admin | — | Array of workspaces |
| `POST /v1/workspaces` | Admin | `{"name":"...","roots":[{"id":"...","path":"..."}]}` (`roots` defaults to `[]`) | Workspace, `201` |
| `POST /v1/sessions` | Admin | `{"runtime":"...","cwd":"...","label":"...","branchId":"...","nativeId":"..."}`; `cwd`, `label`, `branchId`, `nativeId` are optional | Session fields plus `sessionId`, `sessionToken`, `seq`, `201` |
| `GET /v1/sessions` | Admin | — | Sessions with gateway `state` (`active`, `kill-requested`, or `ended`) |
| `GET /v1/sessions/:id` | Admin or that session | — | Session |
| `POST /v1/sessions/:id/end` | Admin or that session | Optional `{ "exitCode":0,"signal":null }` | `{ "ok":true,"state":"ended","processStatus":"unknown"\|"exit-reported" }`; denies pending approvals |
| `POST /v1/sessions/:id/kill` | Admin only | — | `202 {"ok":true,"state":"kill-requested","processStatus":"unknown"}`; requests termination and denies pending approvals |
| `POST /v1/decide` | Session only | `{"requestId":"...","sessionId":"...","tool":"...","input":{},"nativeSessionId":"...","cwd":"..."}`; `requestId` and `tool` required; other fields optional | `{ "approvalId":"...", "outcome":"allow"\|"deny", "reason":"...", "by":"Gateway" }` |
| `GET /v1/approvals` | Admin | — | Ordered array of approval records |
| `POST /v1/approvals/:id` | Admin | `{"decision":"approved"}` or `{"decision":"denied","reason":"..."}` | Updated approval record |
| `GET /v1/workspaces/:id` | Admin or session in workspace | — | Workspace |
| `GET /v1/workspaces/:id/branches` | Admin or session in workspace | — | Branch array |
| `POST /v1/workspaces/:id/branches` | Admin | `{"name":"...","restricted":true}` (`restricted` optional) | Branch, `201` |
| `GET /v1/workspaces/:id/events?after=N&limit=N` | Admin or session in workspace | — | Events after sequence `N`, up to `limit` (defaults `0`, `100`) |
| `POST /v1/events` | Admin or active session | Observed event: `{"id":"...","workspaceId":"...","source":"...","nativeId":"...","sessionId":"...","type":"...","mode":"observed","payload":{},"occurredAt":"..."}` (`sessionId` optional) | `{"inserted":true\|false}` |
| `GET /v1/stream?after=N&workspaceId=...` | Admin or active session | — | Server-sent events, with monotonically increasing global `id` and `seq` |
| `GET /v1/branches/:id/context` | Admin or session permitted for branch | — | Branch snapshot |
| `POST /v1/branches/:id/context` | Session permitted for branch | `{"knowledge":{},"eventIds":["..."],"expected":{"branchRevision":1,"mainRevision":1}}`; optional fields may be omitted | Context commit, `201` |
| `POST /v1/merges` | Admin or session permitted by Core | `{"sourceBranchId":"...","targetBranchId":"...","commitIds":["..."],"expectedRevision":1,"expectedMainRevision":1}` (`expectedMainRevision` optional) | Merge, `201` |
| `GET /v1/merges`, `GET /v1/reviews` | Admin | — | Merge or review array |
| `POST /v1/merges/:id/apply` | Admin or session permitted by Core | — | Applied merge result |
| `GET /v1/reviews/:id` | Admin or session permitted by Core | — | Review |
| `POST /v1/reviews/:id` | Admin | `{"decision":"approved"\|"rejected","resolutions":[{"existingCommitId":"...","incomingCommitId":"...","selectedCommitId":"..."}]}` (`resolutions` optional) | Review result |

`cwd` session registration resolves the path and reuses a workspace whose root path exactly matches. If none exists, it creates a workspace rooted at that path, then creates a branch and session. Pass `branchId` to register into an existing branch instead. The registration `seq` is the global event sequence at registration time.

### Stream cursors

The stream cursor is global across all stored events, not a per-workspace counter. Resume with `Last-Event-ID: <sequence>` (preferred for SSE clients) or `?after=<sequence>`. The header takes precedence. A session credential sees only events for its own session; an admin can optionally filter by `workspaceId`. Filtering does not change the global cursor, so sequence gaps are expected. Each event is framed as `id: <sequence>` and `data: <JSON>`; its JSON also contains `seq`. Reconnect using the last received `id` to avoid replaying earlier rows. The server polls for new events and sends comment heartbeats.

### Approval lifecycle and errors

`POST /v1/decide` first checks Core policy. A direct policy denial returns `{ "outcome": "deny", "reason": "..." }` without creating an approval. Otherwise it creates a pending approval and waits for an admin decision. The default deadline is 60 seconds; `createGateway` accepts `approvalTimeoutMs` for embedding configurations. A pending record becomes `timeout` after its deadline, or `denied` if its session ends. The waiting request then returns `outcome: "deny"`. Admin decisions are terminal; a second decision returns a conflict. Pending approval rows survive a process restart in SQLite, and startup expires overdue rows. A still-unexpired approval remains available for admin inspection and decision after restart. The in-flight `/v1/decide` HTTP request itself does not resume after a restart, so its caller must reconcile the approval record.

Common errors are `{ "error": { "code": "...", "message": "..." } }`: `401 UNAUTHORIZED` for missing/invalid bearer credentials, `403 DENY` for insufficient authority or inactive sessions, `404 NOT_FOUND`, and `409` for state or revision conflicts. Malformed bodies and invalid inputs return `400`.

## Enforcement and integration boundaries

An approval response is a decision made by the policy/approval boundary. It is not proof that a tool ran, was stopped, or completed successfully. Enforcement depends on an attached pre-execution hook honoring the decision; execution evidence must be recorded separately. Gateway-generated decision and session lifecycle records use `mode: "controlled"`; ingested `/v1/events` are required to use `mode: "observed"`. Do not promote observed telemetry to execution proof.

The Gateway's direct tool decision contract is the Claude `PreToolUse` hook path. It does not claim to intercept or control arbitrary Codex tool execution. MCP is a separate tool transport/integration boundary; this HTTP API does not establish MCP server identity or enforce MCP tool calls by itself. Keep those claims and controls separate in Console copy and integration work.

## Fixture flow and handoff

Use [`../fixtures/gateway.http`](../fixtures/gateway.http) with a REST Client extension or copy the requests into curl. Start the server first, read the token from the configured token file, then set the fixture's `adminToken`. Run requests in order through registration, copy the returned `sessionToken` into `sessionToken`, and then run the session-scoped requests. The decide request waits: fetch approvals with the admin token, take the pending record's `id`, approve or deny it, then inspect the returned decision. End the session when finished. The stream request is a long-lived SSE connection; change `after` to a known global cursor to resume it.

Coordination handoff for Persons 2/3: use this document and fixture as the API contract baseline. Person 2 can use the allowlisted Origin login, credentialed fetch, and credentialed EventSource flow above. Person 3 can use the fixture flow to connect a managed launcher/hook, preserving the registration session token and reporting observed event data separately from tool enforcement. Confirm any contract mismatch against `src/gateway.ts` before changing the API. This is a handoff plan only; it does not assert that either person has been contacted or has completed work.

Typed wire contracts are exported from `packages/contracts/src/gateway.ts`; existing Core records are exported from `packages/contracts/src/index.ts`.

Launch managed Claude after building:

```sh
export HARNESS_ADMIN_TOKEN="$(cat ~/.local/share/agentree/admin-token)"
node --input-type=module -e 'import { runManagedClaude } from "./dist/packages/adapters/src/claude-launcher.js"; process.exitCode = await runManagedClaude({label:"Claude",gatewayUrl:"http://127.0.0.1:8787"});'
```

The launcher strips the admin token from the child environment. This is credential separation within a cooperative local application, not OS isolation: an agent running as the same user can read that user's files, including the admin token. Use separate OS identities and filesystem permissions for a hostile-agent threat model. A Console proxy must authenticate its browser users and protect state-changing requests; never make an unauthenticated proxy that injects the admin bearer.

### Request identity and process status

Every `/v1/decide` request requires `requestId`. The hook uses native `tool_use_id` when supplied, otherwise generates an ID once per hook invocation. Retries must retain it. SQLite uniquely binds `(sessionId, requestId)` to the tool and input. Identical retries reuse the pending or terminal approval, including after restart; changed tool/input returns 409. An allow replay is a decision replay, not an exactly-once execution guarantee. Fallback generated IDs cannot identify separately relaunched hooks; integrations should supply a native stable tool ID.

Kill only requests launcher termination: `session.kill-requested` is delivered on SSE and HTTP returns 202. The launcher sends SIGTERM, escalates to SIGKILL after its grace period, and calls `/end` after the child exit event with `{exitCode: number|null, signal: string|null}`. Only that report produces `session.exited`; a bare `/end` closes the logical session without asserting process exit. If the launcher is disconnected, state remains `kill-requested` with process status unknown. This is launcher-reported process evidence, not independent OS verification.
