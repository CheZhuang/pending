# Core integration contract (Person 1 → B/C)

Additive contracts implemented on `feat/core-shared-context`, pending B/C agreement before integration. These were recorded before implementation for adapters/MCP and scope sync/CLI; these are documented before implementation. Existing publish/context/merge positional signatures remain supported. `Workspace.mainBranchId` and `MergeRequest.expectedMainRevision` are required output fields; B/C mocks and persisted DTO assumptions need updating. No transport, native adapter, delivery policy or CLI implementation belongs here.

- Every workspace has one protected `main` branch, identified by `Workspace.mainBranchId`. New agent branches inherit the current accepted main history by reference. Main accepts reviewed merges only; sessions publish drafts on agent branches.
- `contextRevision(branchId)` cheaply detects changes without loading history. `snapshot(branchId, revision?)` returns history, effective knowledge, and a `{ branchRevision, mainRevision }` token. Omitting the token reads live main; passing it reconstructs an immutable snapshot. `ContextCommit.revision` is always its original author branch revision, never a target attachment revision. Each snapshot also returns history entries with the attachment branch/revision.
- `events(workspaceId, { afterSequence?, throughSequence?, limit?, sessionId?, source?, type? })` returns ascending, globally allocated SQLite event sequences, a next cursor, a fixed high-water mark and `hasMore`. Sequences are persisted, immutable and may contain gaps. Repeat the returned high-water mark for a stable paginated read. Native ingestion inputs remain unsequenced and deduplicate by workspace/source/nativeId.
- File/folder scopes gain an optional `rootId`. One-root workspaces infer it; multi-root workspaces require it. Paths are root-relative POSIX paths; separators and dot segments normalize, absolute paths and parent traversal are rejected. Folder `.` means root. Workspace/task scopes remain supported. `Knowledge.scope` is the location, optional `impactScope` defaults to location. No filesystem access is granted by roots/scopes.
- Decision identity is `(key, canonical location scope)`; conflicts concern differing bodies with the same key and overlapping impact scopes. Main decisions are authoritative over overlapping local drafts. Human approval defaults to choosing incoming decisions for compatibility; optional conflict resolutions explicitly choose existing/incoming commit IDs. History is never rewritten or removed. Conflicting incoming decisions must be submitted separately, avoiding order-dependent batch resolution.
- Merge requests capture both target revisions. Review and apply revalidate the token, including inherited main updates. `publish` optionally accepts an expected snapshot token. Core methods continue enforcing workspace/session authorization.

B/C should review the token, event cursor, root ID and impact-scope additions before wiring clients. No teammate service or messaging endpoint is connected in this workspace; this file is the reviewable handoff. No native runtime smoke test is claimed. Successful context reads are authorized without emitting events, so idle sync polls stay idle; denials and writes remain audited.

## Consumer examples

```ts
const token = service.contextRevision(session.branchId);
const view = service.snapshot(session.branchId, token);
// Person C selects relevant items using location/impact scopes before delivery.
const relevant = view.knowledge;
// Agent publications can reject changed local or inherited context.
service.publish(session.branchId, knowledge, eventIds, token);
```

```ts
let page = service.events(workspaceId, { afterSequence: savedCursor, limit: 100 });
// Consume and persist page.nextSequence only after success.
while (page.hasMore) {
  page = service.events(workspaceId, {
    afterSequence: page.nextSequence,
    throughSequence: page.throughSequence,
    limit: 100,
  });
}
// Next poll omits throughSequence. Keep cursors per workspace/filter selection.
```

Tests cover two independent sessions, shared decision replacement, pinned views after restart, stale reviews across two SQLite connections, explicit conflict choices, disjoint roots and impact overlap, immutable history and transaction rollback, event filters/pagination/deduplication/idle polling, and v1 database migration. Adapter/MCP and CLI authentication/wiring plus real-runtime smoke tests remain integration work.
