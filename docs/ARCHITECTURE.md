# Architecture

Agentree supervises independent native agents. Humans own Main and acceptance decisions, native runtimes own planning and execution, and Git owns source control. Human-submitted task dispatch forwards explicit instructions to a supported runner; it does not add autonomous planning or recovery.

## Domain model

**Main** is the shared plain-text reference with optional rooted file references. Human edits, removals, acceptance, and restoration use the expected global Main revision and retain immutable history and provenance. Agent proposals cannot change Main. See [Main API](MAIN_API.md) for revision and restoration rules.

**Branches** are logical work records, independent of Git branches and filesystems. Multiple native sessions can continue one branch. Work proposals contain text, optional intent, affected files, event evidence, and explicit references to incompatible Main entries. Proposed, accepted, and rejected work remains visible.

**Conflicts** have status `potential`, `confirmed`, `resolved`, or `dismissed`. Rooted file overlap, explicit Main incompatibility, and human reports provide evidence. File overlap starts as potential; matching prose is not semantic detection. Humans supply explanations for their assessments. New evidence updates the same signal without reopening its human disposition. Assessment changes supervision records, not source files.

**Merge decisions** accept or reject selected pending work in one atomic human operation. Acceptance creates Main entries with source-work links. Rejection leaves Main unchanged. Acceptance neither replaces an existing Main entry nor resolves conflicts automatically; humans reconcile the shared reference explicitly.

**Corrections** are durable human messages addressed to a branch and pinned to the current Main revision. Sessions retrieve them through MCP. Retrieval and acknowledgment are delivery bookkeeping; agents may fail to poll or follow them.

## Ownership

| Component | Responsibility |
| --- | --- |
| [Contracts](../packages/contracts/README.md) | Domain records, schemas, and Gateway wire types |
| [Core](../packages/core/README.md) | Authorization, Main history, work, conflict evidence, merge decisions, corrections, and policy audit |
| [Storage](../packages/storage/README.md) | SQLite entities, events, transactions, migrations, and cursor queries |
| [Sync](../packages/sync/README.md) | Main snapshots, branch context, corrections, and delivery ledger |
| [MCP](../packages/mcp/README.md) | Session-bound reads and proposals with credential revalidation |
| [Adapters](../packages/adapters/README.md) | Native observation, managed launch, approval callbacks, and ingestion recovery |
| Gateway | REST authentication, browser pairing, lifecycle, approvals, SSE, and [task delivery](TASK_DISPATCH_API.md) |
| [CLI](../apps/cli/README.md) | Direct local database inspection and human supervision commands |
| [Console](../apps/web/README.md) | Human Main editing, branch inspection, conflict assessment, corrections, and approvals |

Actors are constructed at trusted boundaries. Agents read within their workspace and propose only on their session branch. Main mutations, merge/conflict decisions, corrections, workspace creation, and session registration remain human operations. Browser writes require the paired origin. Local CLI identity assumes trusted access to the database.

## Evidence and control

Events retain native identity, source, session, payload, and observed/controlled mode. Native requests and file-change notifications are observations. Gateway approval records describe a pre-execution decision; an allow does not prove execution succeeded. Native completion events are runtime reports, not independent correctness checks.

File evidence uses structured Claude inputs, Codex changes, and normalized touches. Read-only touches are excluded. Known roots and normalized relative paths determine identity, using the longest matching root when roots nest. No filesystem scan, Git diff parser, command-string inference, or source merge engine is involved. The overview shows the latest 30 session events; overlap detection uses the branch sessions' full observed write history and pending proposals.

Native control depends on the configured integration. See the [enforcement matrix](NATIVE_AGENTS.md#supported-controls). Passive observation cannot deliver corrections, and MCP cannot push unsolicited guidance into arbitrary sessions. Tool denial reasons can reach supported intercepted calls. Agentree adds no autonomous retry or conflict resolution.

See [migration](MIGRATION.md) for retained historical entities and removed protocols.
