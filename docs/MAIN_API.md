# Main editing and history contract

Base path: `/v1/workspaces/:workspaceId/main`. Writes use [automatic local human access](GATEWAY_API.md). Session credentials may read their own workspace; agents cannot edit or restore Main. Actor identity always comes from Gateway authentication.

| Method and path | Request | Response |
| --- | --- | --- |
| GET base | — | Current `MainSnapshot` |
| POST base | `{body, files?, expectedRevision}` | Created `MainEntry` (201) |
| POST base`/:entryId` | `{body, files?, expectedRevision}` | Updated `MainEntry` |
| POST base`/:entryId/remove` | `{expectedRevision}` | Removed `MainEntry` |
| GET base`/history` | — | `MainRevision[]`, ascending global revision |
| GET base`/:entryId/history` | — | `MainEntry[]`, ascending revision, including removals/restorations |
| GET base`/preview?revision=R` | — | Historical `MainSnapshot` at global revision R |
| POST base`/restore` | `{revision, expectedRevision}` | New current `MainSnapshot` |
| POST base`/:entryId/restore` | `{revision, expectedRevision}` | Restored `MainEntry` from snapshot R |

The existing POST entry form with `remove:true` remains supported. Normal edits require a body; omitted files preserve existing references, and `files:[]` clears them. Removal copies the current entry content. Removed entries must be restored before editing.

`expectedRevision` is the current **global Main revision**, including for single-entry operations. A stale request returns HTTP 409 `{error:{code:"STALE",message,details:{expectedRevision,currentRevision}}}`; refresh and review before retrying. Revisions must be nonnegative safe integers. Unknown/future historical revisions return 404; invalid revisions return 400. Revision zero is the empty initial Main.

Restoration selects the state **at a global revision**, not an entry-local version number. Single-entry restoration requires that the entry existed then, and copies its historical body, files and removed state. Select its last active revision to recover a removed entry. Whole-Main restoration restores all entries that existed at R, including their removed state; entries created later become tombstones. No source files, Git state, branch proposals, acceptance records or agent execution are undone.

Every successful restoration advances Main by exactly one, even when the selected contents equal current contents. All affected entries share that new revision, and the operation is atomic. Entry versions, their original actors, acceptance/source-work references and legacy evidence remain immutable. New versions identify the restoring human and timestamp, retain `sourceWorkId`/`legacyCommitId`, and carry `restoredFrom:{revision,entryRevision?}` pointing to their source. `entryRevision` is absent when a later-created entry is tombstoned because it did not exist at R. Global history records `revision`, `actor`, `createdAt`, `entryIds`, and optional `restoredFromRevision`; a whole restoration of empty Main is recorded too.

Historical snapshots use retained immutable entry versions. See [migration](MIGRATION.md) for legacy history limits and schema compatibility.

ContextSync publishes each restored Main as a new complete snapshot under its new revision. Authenticated MCP `context_get` and new `context_sync` requests see it through the existing read boundary (a retry of the same sync request ID retains its cached response).

Examples (include the appropriate authentication header; replace `W` and `E` with actual IDs):

```http
POST /v1/workspaces/W/main/E
Content-Type: application/json

{"body":"Use API v2 and preserve request IDs","expectedRevision":4}

GET /v1/workspaces/W/main/preview?revision=2

POST /v1/workspaces/W/main/E/restore
Content-Type: application/json

{"revision":2,"expectedRevision":5}

POST /v1/workspaces/W/main/restore
Content-Type: application/json

{"revision":0,"expectedRevision":6}
```
