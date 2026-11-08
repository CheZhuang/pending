# Native task dispatch API

Humans submit explicit instructions to an active managed native session. PendingTree records delivery evidence; the native runtime owns execution. Authentication and error envelopes follow the [Gateway API](GATEWAY_API.md). Human routes use automatic local access; native runner routes require the target session credential. Credentials are never included in task records.

## Human routes

| Method and path | Behavior |
| --- | --- |
| POST `/v1/tasks` | Submit `{sessionId,instructions,requestId,includeMain?}`; returns task (201) |
| GET `/v1/tasks?sessionId=...` | List tasks newest first; session filter is optional |
| GET `/v1/tasks/:id` | Read one task |
| POST `/v1/tasks/:id/cancel` | Cancel undelivered work or request interruption |

`requestId` is required and globally unique. Repeating the same request returns the original task; changing its session, instructions, or `includeMain` under the same ID returns HTTP 409. `includeMain` defaults to false. When true, the request stores the current Main revision and active entry IDs/bodies at submission. Instructions and captured Main context remain immutable.

Records contain `id`, `requestId`, `workspaceId`, `branchId`, `sessionId`, `runtime`, `instructions`, `includeMain`, `mainContext`, `submittedBy`, submission/update timestamps, `status`, and optional `nativeTurnId`/`reason`.

Only a connected, active `ManagedCodex.open` runner can receive tasks. Existing Claude CLI sessions return a durable `delivery-unavailable` record. Arbitrary Codex Desktop conversations are not managed targets. The Console Tasks page uses these HTTP routes.

## Delivery states

| Status | Evidence / meaning |
| --- | --- |
| `submitted` | Recorded and awaiting runner claim |
| `delivery-pending` | Runner claimed the request |
| `native-accepted` | Native `turn/start` returned a turn ID |
| `running` | Matching native `turn/started` observed |
| `completed` / `failed` | Matching native `turn/completed` reports terminal status |
| `delivery-unavailable` | No supported connected delivery path, or session ended before claim |
| `cancel-requested` | Interruption requested; no terminal outcome established |
| `cancelled` | Cancelled before native delivery |
| `outcome-unknown` | Delivery may have occurred without terminal native evidence |

Before delivery, cancellation marks the task cancelled. After claim/acceptance it requests interruption; the managed Codex runner sends `turn/interrupt` once the turn ID is known. Terminal status still depends on evidence. Killing a session is separate and may affect multiple tasks.

On Gateway restart, in-flight tasks become `outcome-unknown`; claimed work is not automatically redelivered. A delivery RPC failure may also be uncertain because native acceptance can precede the failure. Later matching terminal evidence can resolve an unknown outcome. Native completion does not independently verify correctness.

## Internal runner routes

| Method and path | Behavior |
| --- | --- |
| GET `/v1/native/tasks/next` | Heartbeat and claim the oldest queued task, or return null |
| GET `/v1/native/tasks/next?busy=1` | Heartbeat without claiming work |
| GET `/v1/native/tasks/:id` | Read the bound session's task |
| POST `/v1/native/tasks/:id/accepted` | Record `{nativeTurnId}` |
| POST `/v1/native/tasks/:id/unavailable` | Report `{reason}`; a claimed delivery failure may be `outcome-unknown` |

These are runner integration points, not Console routes. Task transitions emit controlled Gateway `task.*` events through existing history/SSE; native turn notifications remain observed events. See [Codex implementation](../packages/adapters/CODEX_APP_SERVER.md) and [real smoke checks](../demo/REAL_AGENTS.md).
