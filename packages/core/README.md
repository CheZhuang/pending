# Core service boundary

`AgentreeService(store, actor)` is instantiated by a trusted daemon authentication layer. Agent connections must be bound to their registered session ID; never accept an `Actor` or a human ID from an agent request body. Human callers must be authenticated by the host application. The core does not implement daemon transport authentication.

`ApplicationService` exports the daemon-facing structural interface (also suitable for mocks). Session registration is a human administrative action. Agents may read other branches within their registered workspace, publish on their own branch, and propose merges. Logical branches have no relationship to Git branches. Roots describe the workspace; they do not grant filesystem access.

`context` returns immutable history; `lookup` returns findings plus the latest accepted decision for each key. Findings remain findings. A decision key is a workspace-wide authoritative identity. Replacement decisions require a merge review when their contents differ. Restricted branches always require merge review. Review approval is revalidated against the original target revision both when decided and when applied. A stale proposal must be recreated and reviewed again.

All managed methods call the policy gate before mutation. Policy decisions are committed independently so denied and failed operations remain auditable. Successful domain mutations and their events commit atomically. `executeControlled` demonstrates pre-execution enforcement: agents in the workspace receive require-approval, unauthorized workspaces receive deny, humans receive allow. Approval for this demonstration is human execution, not a reusable permission token. Its callback must be synchronous; external side effects cannot participate in a SQLite transaction.

Native events enter only through `ingest` with `mode: observed`. They are observations and grant no permission, including events claiming a native tool ran. Native IDs must be stable across adapter restarts and namespaced by runtime/session in `source`. The gateway does not control native CLI tools, operating system commands, or arbitrary filesystem access.

Use a user-level application data path when opening `SqliteStore`; tests may use temporary paths or `:memory:`. Node 24+ supplies SQLite without a native npm addon. WAL and foreign keys are enabled on every connection. Storage and raw SQL access are internal trusted infrastructure, never agent API endpoints.
