# Agentree Web Console

The console is a human supervision surface for the local Gateway. It is built with Vue 3, Vite, Naive UI, and Vue Router.

| Page | What it shows |
| --- | --- |
| **Overview** | Logical branches, native sessions, lifecycle state, stop requests, and adapter-declared capabilities |
| **Main** | The shared human-maintained reference: create, edit (with a change preview), remove and restore entries; file references, revision and provenance; per-entry version history with single-version restore |
| **Main history** (`/main/history`) | Global Main revisions, a Gateway-built preview of Main at any revision compared with the current Main, and whole-snapshot or single-entry restore with a confirmation listing exactly what will be reversed |
| **Tasks** | Send an instruction (plus optional context and a Main snapshot) to one managed agent session; status from Gateway task records and native turn evidence; supported cancellation; link to the agent's activity |
| **Branches** | Agent work proposals, reported file references, recent session activity, direct acceptance or rejection, and corrections |
| **Conflicts** | Potential and confirmed conflict evidence, human reports, and explained confirm, resolve, or dismiss decisions |
| **Activity** | Live events from history and SSE, with observed telemetry, runtime-reported results, intercepted decisions, and Gateway records distinguished |
| **Approvals** | Pending controlled tool approvals and their terminal outcomes |

Main is text guidance for agents. File references are evidence and labels; the Console does not edit source files or perform Git operations. Branches are logical work records, not Git branches. File overlap starts as potential evidence and does not itself establish incompatibility. Runtime-reported completion is not independent proof of correctness, and an intercepted tool decision is not proof the tool ran.

## Run it

Use Node 20.19+ or 22.12+ for the Console (the Gateway itself needs Node 24).

```bash
cd apps/web
npm install
npm run dev            # http://localhost:5173, mock data
```

## Mock mode

Mock mode mirrors the supervision records and API: Main entries, global revisions, previews and restores (docs/MAIN_API.md), proposed branch work, conflicts, corrections, merges, session activity, tool approvals, and task dispatch (docs/TASK_DISPATCH_API.md): a managed Codex session that moves a task through native turn evidence, and a Claude Code session that cannot receive tasks. Changes reset when the page reloads.

`npm test` runs the UI behavior tests without a browser: the rollback comparison, task status rules, realistic mock workflows (edit Main, restore an entry and a whole revision, stale and unknown revisions, submit a task and follow its native evidence, unavailable agents, interruption, stopped sessions), and the live client against an older Gateway.

## Live mode

```bash
# terminal 1, repository root, Node 24+
npm ci && npm run build && npm start
```

```bash
# terminal 2
cd apps/web && npm run dev:live
```

The Console asks for the admin token once and pairs it through `POST /v1/console/login`. The token is never stored by the page; REST and SSE use the HttpOnly cookie. Open the Console on **localhost** to match the Gateway's default allowed origin. Change the Gateway URL with `VITE_GATEWAY_URL`.

## Build

```bash
npm run build && npm run preview
```

The live API adapter is in `src/api/live.js`; the in-browser implementation is in `src/api/mock.js`. Both expose the same methods. The Gateway is authoritative for writes and revision checks. The Console displays server errors instead of treating a local decision as successful.

## Integration checklist

The Console talks only to these Gateway routes. Check each one when the backend changes.

| Area | Routes | Verify |
| --- | --- | --- |
| Main edit | `POST /v1/workspaces/:w/main`, `POST …/main/:entry`, `POST …/main/:entry/remove` | Edit with an old revision returns `409 STALE` with `details.{expectedRevision,currentRevision}`; the Console shows the reload dialog and writes nothing |
| Main history | `GET …/main/history`, `GET …/main/:entry/history`, `GET …/main/preview?revision=R` | History is an array; a preview's `revision` equals `R`. If not (a Gateway without PR #20), the Console shows **UNSUPPORTED** instead of a wrong preview |
| Restore | `POST …/main/restore`, `POST …/main/:entry/restore` with `{revision, expectedRevision}` | A restore is exactly one new revision with `restoredFromRevision`; restored versions carry `restoredFrom`; the Console never builds history locally |
| Tasks | `POST /v1/tasks` (with a client `requestId`), `GET /v1/tasks`, `POST /v1/tasks/:id/cancel` | Retrying with the same `requestId` returns the same task; a Claude Code session gives `delivery-unavailable` with a reason; sessions report `taskDispatch.available` |
| Evidence | SSE `/v1/stream` | `task.*` records carry `{taskId, status, nativeTurnId, reason}`; native `turn/started` / `turn/completed` carry the same turn id, so the task drawer can pair them |

Known backend limits shown in the UI rather than worked around:
- Only a managed Codex App Server session with a polling runner receives tasks. Claude Code CLI sessions cannot accept unsolicited tasks (`delivery-unavailable`).
- `running`, `completed` and `failed` depend on native turn events; `outcome-unknown` is final and never retried automatically.
- Cancelling an accepted task asks Codex to interrupt; the result arrives as native evidence (usually `failed` with the native status), not as `cancelled`.
- There is no route to list tasks per workspace; the Console filters `GET /v1/tasks` by the workspace's sessions.
