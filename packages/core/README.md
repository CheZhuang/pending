# Core service boundary

`AgentreeService(store, actor)` is instantiated by a trusted daemon authentication layer. Agent connections must be bound to their registered session ID; never accept an `Actor` or a human ID from an agent request body. Human callers must be authenticated by the host application. The core does not implement daemon transport authentication.

`ApplicationService` exports the daemon-facing structural interface (also suitable for mocks). Session registration is a human administrative action. Agents may read branches within their registered workspace, publish on their own branch, and propose merges. Logical branches have no relationship to Git branches. Roots describe the workspace; they do not grant filesystem access. Adapters, MCP, scoped delivery and CLI remain B/C responsibilities. See [INTEGRATION.md](./INTEGRATION.md) for the shared contract handoff.

## Shared context and revisions

Each workspace has a protected `mainBranchId`. Main accepts human-reviewed merges, and cannot receive new agent sessions or direct publications. Every other branch inherits live main context by reference, including branches created before an update. No inheritance edges or copied commits are stored. Local branch revisions change only when local commits are attached; `mainRevision` independently detects shared updates.

`contextRevision(branchId)` is a cheap change check. `snapshot(branchId)` returns its token `{ branchRevision, mainRevision }`, immutable `history`, effective `knowledge`, and `entries` with attachment branch/revision. Pass a previous token to `snapshot` to reconstruct that view. Both revisions are nonnegative attachment counts. A commit's own `revision` always describes its author branch; an imported commit can have a different target attachment revision. History orders local entries before main entries, with duplicates represented once at their main attachment. It is not a global timeline.

`context` returns snapshot history; `lookup` returns findings and current decisions. Findings remain findings. Effective decisions come from append-only decision choices rather than arbitrary history order. Main decisions take authority over overlapping local proposals. Drafts remain visible in history even when a shared decision takes precedence. A branch may publish a competing proposal against inherited main; replacing an existing local decision requires merge review.

`publish(branchId, knowledge, eventIds?, expectedToken?)` can reject a stale snapshot before writing. `createMerge(source, target, commitIds, expectedBranchRevision, expectedMainRevision?)` captures both target revisions. Supplying `expectedMainRevision` checks the consumer's observed token; omitting it captures current main for compatibility. Review and apply always revalidate both values. Unrelated main changes also invalidate a review; this conservative rule keeps the MVP simple. Recreate and review stale proposals.

## Scopes and decision review

File/folder paths are canonical root-relative POSIX paths. Backslashes, repeated separators and `.` segments normalize; absolute paths and any `..` segment are rejected. Folder `.` denotes its root. `rootId` is inferred with one root, required with multiple roots, and omitted in legacy zero-root workspaces. Roots use absolute lexical paths; symlinks are not resolved. Workspace and task scopes remain supported. Exported scope helpers are pure and make no filesystem access decisions.

`Knowledge.scope` locates a decision; optional `impactScope` describes what it affects and defaults to location. Identity is key plus canonical location. Different bodies conflict when identities match or the same key has overlapping impact scopes. Different roots are disjoint; folder overlap respects path segments. Tasks with different IDs are disjoint, while task versus file/folder overlap is conservative because the core has no task-to-location mapping. B/C own scope relevance and delivery selection.

Main and restricted targets always require human review. Other targets require review for conflicts. Conflicting incoming decisions must be submitted separately; batch order never resolves conflicts. Approval chooses incoming by default for compatibility. `resolveReview(reviewId, 'approved', resolutions?)` also accepts one `{ existingCommitId, incomingCommitId, selectedCommitId }` per conflict. Keeping existing still attaches the proposal to history, without making it effective. Equivalent bodies at different locations coexist. Selecting incoming supersedes conflicting existing decisions as whole records; there is no automatic splitting into scope fragments. Choices involving the same incoming or existing record must be consistent.

## Events and transactions

`events(workspaceId, query?)` returns sequenced events, `nextSequence`, `throughSequence`, and `hasMore`. SQLite allocates globally increasing immutable sequences; gaps are valid. Query filters include `sessionId`, `source` and `type`, and `limit` is 1–1000 (default 100). Sequences order persistence, independently of `occurredAt`. Feed `nextSequence` into `afterSequence`; preserve `throughSequence` across pages for a fixed read. After draining, omit `throughSequence` to poll subsequent events. Persist a cursor only after successfully consuming its page.

Native events enter only through `ingest` with `mode: observed`; `gateway` is a reserved source. Native IDs must be stable across adapter restarts and namespaced by runtime/session in `source`. Deduplication uses workspace/source/nativeId. A duplicate returns false and does not change the original event or sequence. Provenance uses an indexed event ID lookup and requires the publishing session. Observations grant no permission, including events claiming a native tool ran.

Managed methods enforce policy before mutation. Policy decisions commit independently so denied and failed writes remain auditable. Successful mutations, decision choices, and their events commit atomically. Successful context reads do not append audit events, so sync polling remains idle; denied reads are audited. `executeControlled` enforces policy before executing its synchronous callback. Its external side effects cannot participate in a SQLite transaction. Native CLI tools, OS commands and arbitrary filesystem access are outside gateway enforcement.

## Storage and migration

Use a user-level application data path for `SqliteStore`; tests may use temporary paths or `:memory:`. Node 24+ supplies SQLite without a native addon. WAL and foreign keys are enabled on every connection. Storage/raw SQL are trusted infrastructure, never agent endpoints. Domain methods use indexed workspace, session, event and branch membership queries; decision snapshots use a branch-scoped indexed history projection. `contextRevision` and event polling avoid loading context history; `snapshot`, `context` and `lookup` return context arrays.

Schema v2 upgrades v1 transactionally, preserving original commits, events, IDs, and event insertion order. It creates or adopts a workspace's main branch, protects it, records initialization, and backfills decision choices. Old reviews against a workspace with a nonempty adopted main are stale because they never pinned inherited context. Existing sessions on an adopted main remain readable but cannot publish there; register a new session on an agent branch. Generic history deletion and commit/event mutations remain blocked. Redundant reference-validation and duplicate deletion triggers were removed; SQLite foreign keys and core authorization/validation retain integrity.

Run `npm test`, `npm run typecheck`, and `npm run build` from the repository root.
