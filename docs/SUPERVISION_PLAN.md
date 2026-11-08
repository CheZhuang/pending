# Supervision refactor plan

Agentree observes independent native agents. It does not plan their tasks, edit their source files, merge Git commits, or recover their runtimes.

## Retain

Keep workspace roots, logical branches and native sessions distinct. Retain authenticated session binding, observed event deduplication and cursors, tool interception/approval, lifecycle records, SQLite transactions and append-only audit events. Keep native Claude hooks, Codex App Server/journal monitoring, MCP credential revalidation, browser pairing and SSE.

## Replace and simplify

Replace finding/decision context commits, scopes, knowledge authority ranks, merge requests and separate reviews with plain-text Main entries, branch work proposals, one Conflict record, and a human acceptance/rejection operation. Main is the human-governed shared reference, with optimistic revision checks, entry history, removals and provenance. Branch work contains text, optional affected files, native evidence and explicit references to incompatible Main entries. Branch records are never Git branches.

Main changes are human-only. Acceptance copies selected work into Main with its origin recorded; it never invokes Git or changes source code. A separate review/apply workflow adds no authority and is removed from the new API and Console. Conflict evidence is deterministic file overlap, an explicit reported incompatibility, or a human report. Overlap starts as potential; only humans confirm, dismiss or resolve. No keyword comparison claims semantic incompatibility.

Corrections are durable human messages addressed to a branch. Native agents retrieve Main, sibling work and their corrections through authenticated MCP/context sync. Retrieval or acknowledgment is not proof of behavioral compliance. No unsupported native push is claimed.

## Trace and ownership

- Contracts: lightweight supervision records and request shapes.
- Storage: preserve entities/events and legacy tables; migrate existing accepted Main content and local work once, retaining original IDs/provenance as migration evidence.
- Core: authorization, revision/history, acceptance, conflict evidence and correction records.
- Sync: retrieve current authoritative Main and branch context with durable delivery metadata; remove knowledge ranking/merging from the active protocol.
- MCP: bind all reads/proposals to the authenticated native session, expose supervision context without agent authority over Main.
- Adapters: retain native telemetry, approval boundaries and secure runtime binding. Reuse existing rooted file extraction.
- Gateway: expose Main maintenance, branch supervision, conflicts, acceptance and corrections alongside preserved session/event/approval endpoints.
- CLI: keep native launch/session/approval operation and adapt context commands to the new records.
- Vue Console: Main editor/history, branch work/activity/files, conflicts and correction controls; preserve approvals and monitoring.

## Migration and compatibility

Increment SQLite schema version, transactionally materialize old accepted Main content and branch proposals, preserving legacy records and audit events as historical evidence. Do not reinterpret old pending reviews as approval. Old context/merge/review write protocols are intentionally replaced; native session credentials, observations, approvals and lifecycle data remain valid. New Main revisions invalidate stale writes. Legacy tables remain only for historical data and migration, not a parallel product workflow.

## Verification

Cover human Main CRUD/history and agent denial, both native runtimes retrieving updates, rooted observed/declared file overlap as potential, explicit Main incompatibility, human conflict disposition/correction, acceptance/rejection with stale checks, migration/restart, session isolation, durable ingestion and unchanged native approvals. Build backend and Vue; run tests and a deterministic two-agent end-to-end scenario. Document native delivery limits explicitly.
