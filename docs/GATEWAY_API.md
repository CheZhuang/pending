# Gateway API

Run the local daemon with Node.js 24+. Keep the generated admin credential local. Native sessions use their own session bearer credential; the Console pairs using the admin token and receives an HttpOnly cookie. Allowed Console origins and the existing write-origin check remain enforced. HTTP input never selects a Core actor.

## Supervision API

All paths below are under `/v1`. Human writes require an admin bearer or paired Console session. Agents may read only their workspace and submit work only on their own branch. Errors use `{error:{code,message}}`; stale Main writes return HTTP 409 / `STALE`.

| Method and path | Behavior |
| --- | --- |
| GET `/workspaces/:id/main` | `{workspaceId,revision,entries}` current human-governed reference |
| POST `/workspaces/:id/main` | Human creates `{body,files?,expectedRevision}` |
| POST `/workspaces/:id/main/:entryId` | Human edits `{body,files?,expectedRevision,remove?}`; removal retains history |
| GET `/workspaces/:id/main/:entryId/history` | Every retained revision, including removal |
| GET `/workspaces/:id/supervision` | Main, branch/session/work/activity/file summaries, conflicts and corrections |
| GET `/branches/:id/work` | Branch overview, sessions, work, affected files, recent activity and corrections |
| POST `/branches/:id/work` | Authenticated agent submits `{body,files?,intent?,eventIds?,conflictsWithMain?}` |
| POST `/branches/:id/merge` | Human `{workIds,decision:"accepted"\|"rejected",expectedMainRevision}`; one atomic decision |
| GET `/workspaces/:id/merges` | Accepted/rejected work-record decisions |
| GET `/workspaces/:id/conflicts` | Potential signals and retained human dispositions |
| POST `/workspaces/:id/conflicts` | Human report `{branchIds,mainEntryId?,explanation}` |
| POST `/workspaces/:id/conflicts/:id` | Human `{status,explanation}`; status potential/confirmed/resolved/dismissed |
| POST `/branches/:id/corrections` | Human sends `{body}`; durable branch-addressed correction |

Text-only Main edits retain file references; pass `files:[]` to clear them. Main snapshots include `removedEntries` for retained removal history.

`files` contains `{rootId,path}` with canonical workspace-relative paths. Main text may contain project context, expectations or accepted outcomes; no knowledge kind, key, scope or impact scope is required. Explicit `conflictsWithMain` values must identify current Main entries. File overlap is potential evidence. Agentree does not infer semantic incompatibility from matching words.

**Merge accepts work records into Main. It does not merge Git commits, modify files or execute code.** It does not automatically replace another Main entry. Humans edit the reference explicitly to reconcile conclusions. Main revision checks cover the entire accepted selection. Corrections are retrieved through native MCP; sending is not a promise of delivery or behavioral compliance.

## Preserved native and monitoring endpoints

- `GET /health` reports daemon health.
- `GET|POST /workspaces`, `GET /workspaces/:id`, `GET|POST /workspaces/:id/branches` retain workspace and logical branch operations.
- `POST /sessions` registers `{runtime,cwd?,label?,branchId?,nativeId?}` using a human credential. It returns a session binding and session token. Use `cwd` or an existing branch; Main cannot own a native session.
- `GET /sessions` and `GET /sessions/:id` expose lifecycle, process exit reports and runtime capabilities. Session credentials may retrieve their own binding.
- `POST /sessions/:id/kill` requests stopping; `POST /sessions/:id/end` records end/exit reports. A kill request is distinct from reported process exit.
- `POST /events` ingests normalized **observed** events. `(workspace,source,nativeId)` deduplicates retries; session/workspace identity is validated.
- `GET /workspaces/:id/events?after=0&limit=1000` returns a durable sequence page. Core also supports frozen through-sequence windows and session/source/type filters.
- `GET /stream?workspaceId=:id&after=0` delivers SSE with event IDs and reconnect cursors. Native credentials see their own session events.
- `POST /decide` is the native pre-execution tool approval boundary; `GET /approvals` and `POST /approvals/:id` serve human review with `{decision:"approved"|"denied",reason?}`. Timeouts and ended sessions deny execution. Approval does not imply native success.
- `POST /console/login` requires the admin bearer and allowed Origin. `POST /console/logout` clears the paired browser cookie.

The previous `/branches/:id/context`, `/merges`, `/merges/:id/apply` and `/reviews` governance routes are removed. Update clients to the supervision API; old immutable records remain archival migration evidence.
