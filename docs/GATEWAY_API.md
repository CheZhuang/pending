# Gateway API

Run the local daemon with Node.js 24+. Local human requests carry no credentials. Native sessions retain individual bearer credentials. See [local security](LOCAL_SECURITY.md). HTTP input never selects a Core actor.

See [Main editing, history and restoration](MAIN_API.md) for the complete Main contract, and [task dispatch](TASK_DISPATCH_API.md) for explicit native task submission. The [quick start](../README.md#quick-start) documents startup and configuration. [fixtures/gateway.http](../fixtures/gateway.http) contains manual HTTP requests.

## Supervision API

All paths below are under `/v1`. Human requests omit Authorization and browser writes require an allowed Origin. Agents may read only their workspace and submit work only on their own branch. Errors use `{error:{code,message}}`; stale Main writes return HTTP 409 / `STALE`.

| Method and path | Behavior |
| --- | --- |
| GET `/workspaces/:id/main` | `{workspaceId,revision,entries,removedEntries}` current human-governed reference |
| POST `/workspaces/:id/main` | Human creates `{body,files?,expectedRevision}` |
| POST `/workspaces/:id/main/:entryId` | Human edits `{body,files?,expectedRevision,remove?}`; removal retains history |
| GET `/workspaces/:id/main/:entryId/history` | Every retained entry revision, including removal/restoration |
| GET `/workspaces/:id/main/history` | Global Main revision records |
| GET `/workspaces/:id/main/preview?revision=R` | Historical snapshot |
| POST `/workspaces/:id/main/:entryId/remove` | Human `{expectedRevision}` removal |
| POST `/workspaces/:id/main/restore` | Human `{revision,expectedRevision}` whole-Main restoration |
| POST `/workspaces/:id/main/:entryId/restore` | Human `{revision,expectedRevision}` entry restoration |
| GET `/workspaces/:id/supervision` | Main, branch/session/work/activity/file summaries, conflicts and corrections |
| GET `/branches/:id/work` | Branch overview, sessions, work, affected files, recent activity and corrections |
| POST `/branches/:id/work` | Authenticated agent submits `{body,files?,intent?,eventIds?,conflictsWithMain?}` |
| POST `/branches/:id/merge` | Human `{workIds,decision:"accepted"\|"rejected",expectedMainRevision}`; one atomic decision |
| GET `/workspaces/:id/merges` | Accepted/rejected work-record decisions |
| GET `/workspaces/:id/conflicts` | Potential signals and retained human dispositions |
| POST `/workspaces/:id/conflicts` | Human report `{branchIds,mainEntryId?,explanation}` |
| POST `/workspaces/:id/conflicts/:id` | Human `{status,explanation}`; status potential/confirmed/resolved/dismissed |
| POST `/branches/:id/corrections` | Human sends `{body}`; durable branch-addressed correction |
| GET `/sessions/:id/corrections/pending` | Session credential; managed runtime retrieves corrections not yet delivered to that session |
| POST `/sessions/:id/corrections/delivered` | Session credential; `{itemIds}` records runtime acceptance for correction delivery |

Text-only Main edits retain file references; pass `files:[]` to clear them. Main snapshots include `removedEntries` for retained removal history.

`files` contains `{rootId,path}` with canonical workspace-relative paths. Main text may contain project context, expectations or accepted outcomes; no knowledge kind, key, scope or impact scope is required. Explicit `conflictsWithMain` values must identify current Main entries. File overlap is potential evidence. Agentree does not infer semantic incompatibility from matching words.

**Merge accepts work records into Main. It does not merge Git commits, modify files or execute code.** It does not automatically replace another Main entry. Humans edit the reference explicitly to reconcile conclusions. Main revision checks cover the entire accepted selection. Supervision read models include per-session correction delivery state. Human `GET /workspaces/:id/conflicts?evidence=1` adds bounded current checkout evidence (Git status/diff/history and current file metadata) for referenced paths; this evidence describes the shared workspace checkout and is not branch attribution or semantic conflict resolution.

## Preserved native and monitoring endpoints

- `GET /health` reports daemon health.
- `GET|POST /workspaces`, `GET /workspaces/:id`, `GET|POST /workspaces/:id/branches` retain workspace and logical branch operations.
- `POST /sessions` registers `{runtime,cwd?,label?,branchId?,nativeId?}` as the local human. It returns a session binding and session token. Use `cwd` or an existing branch; Main cannot own a native session.
- `GET /sessions` and `GET /sessions/:id` expose lifecycle, process exit reports and runtime capabilities. Session credentials may retrieve their own binding.
- `POST /sessions/:id/kill` requests stopping; `POST /sessions/:id/end` records end/exit reports. A kill request is distinct from reported process exit.
- `POST /events` ingests normalized **observed** events. `(workspace,source,nativeId)` deduplicates retries; session/workspace identity is validated.
- `GET /workspaces/:id/events?after=0&limit=1000` returns a durable sequence page. Core also supports frozen through-sequence windows and session/source/type filters.
- `GET /stream?workspaceId=:id&after=0` delivers SSE with event IDs and reconnect cursors. Native credentials see their own session events.
- `POST /decide` is the native pre-execution tool approval boundary; `GET /approvals` and `POST /approvals/:id` serve human review with `{decision:"approved"|"denied",reason?}`. Timeouts and ended sessions deny execution. Approval does not imply native success.
- Console login/logout endpoints have been removed; no cookies are issued.

Human task routes are `POST|GET /tasks`, `GET /tasks/:id`, and `POST /tasks/:id/cancel`; session-bound runner routes are listed in the [task dispatch contract](TASK_DISPATCH_API.md).

See [migration](MIGRATION.md) for retired context/merge-request/review routes and retained historical records.
