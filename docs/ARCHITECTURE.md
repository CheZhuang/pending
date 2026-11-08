# Supervision architecture

## Product boundary

Agentree is an external supervision layer. Native agents own planning, tools, code changes and self-correction. Git owns source control. Agentree observes evidence, holds a human-governed shared reference, records potential incompatibilities and communicates corrections. It neither schedules tasks nor rewrites an agent's work.

## Domain behavior

**Main** consists of plain-text entries with optional workspace-root-relative file references. Humans create and edit entries directly, or remove them from the current reference. Every write requires the expected global Main revision, creates a retained revision record and an audit event, and advances Main. Text-only edits retain file references; an explicit empty file list clears them. Removal retains history; create a new entry to replace a removed one. Agent proposals cannot change Main. Provenance identifies the human editor, origin work (when accepted), and migration source where relevant. Editing the same entry supersedes its prior revision.

**Branch** is an independent agent work record. Native sessions bind to a branch; multiple sessions can continue the same work record. Work proposals contain text, optional intent, affected files, native event references and optional explicit references to incompatible Main entries. There are no required knowledge categories, keys or task/folder scopes. Observed native events remain evidence, never grants of authority. Proposed, accepted and rejected work remains visible with provenance.

**Conflict** has one shape and one status: potential, confirmed, resolved or dismissed. Rooted file overlap between branch proposals or recent reported file activity creates a potential signal. Overlap with files referenced in Main also creates a potential signal. A proposal can explicitly cite a Main incompatibility, and a human can report one directly. Signals include evidence IDs, file references, branches and the relevant Main entry. File overlap never proves incompatibility; body words and keyword equality are not semantic detection. A human supplies the explanation when confirming, resolving or dismissing. This changes Agentree's assessment, not source files. New evidence creates a new signal; recorded human dispositions remain in history.

File observations use existing native shapes: Claude tool names and inputs, Codex changes, and normalized rooted touches. Read-only touches are excluded. Recent native activity is limited to the latest 30 session-associated events per branch; explicit proposed files persist until accepted or rejected. Paths are compared by workspace root and normalized relative path, selecting the longest matching root for declarations and native observations when roots are nested. No filesystem scanning, Git diff parser or source merge engine is introduced. Native runtimes that expose only command strings may provide no attributable file changes; users can declare affected files in proposals.

**Merge** is a single human acceptance/rejection operation on selected pending work records from a branch. Acceptance creates Main entries containing those work outcomes with origin links. Rejection leaves Main unchanged. The operation checks Main revision and validates the entire selection before writing; acceptance and rejection are audited and durable. It does not supersede existing Main entries automatically, resolve conflicts automatically, execute code, or touch Git. Humans can edit an existing Main entry to reconcile accepted conclusions with previous expectations.

**Corrections** are durable human messages addressed to a branch, pinned to the Main revision visible when sent. Relevant sessions retrieve them through supported authenticated MCP tools. Retrieval and explicit acknowledgment are delivery bookkeeping, not proof that the runtime changed its behavior. The human can revise Main, send a correction, inspect subsequent native work, and decide whether the incompatibility is resolved.

## Module ownership

| Module | Responsibility |
| --- | --- |
| Contracts | Supervision records, validation, native session/event and Gateway wire contracts |
| Core | Workspace access, human Main authority, revision/history, proposals, deterministic conflict evidence, human merge decisions and corrections |
| Storage | SQLite entity persistence, transactional migration, event identity/deduplication, cursor queries and historical evidence |
| Sync | Current Main replacement snapshots, unapproved branch context and targeted corrections with durable retrieval/acknowledgment bookkeeping |
| MCP | Session-bound agent reads and proposals; native credentials revalidated for every tool |
| Adapters | Native observation, secure runtime/session binding, durable ingestion cursors and supported pre-execution interception |
| Gateway | Bearer/cookie authentication, human REST actions, native session lifecycle, approvals and SSE |
| CLI | Local daemon/native launch, monitoring and direct supervised reference operations |
| Vue Console | Main maintenance/history, branch inspection, potential conflicts, corrections, acceptance/rejection and tool approvals |

Core actors are constructed at trusted boundaries, not deserialized from agent arguments. Agents can read within their workspace and propose only on their session branch. They cannot edit Main, decide merges/conflicts, send human corrections, register sessions or create workspaces. Browser writes retain the paired-origin check. Native approvals remain separate from domain acceptance: approving a tool call authorizes that intercepted call, not its output as Main content.

## Observation and enforcement

Events keep their original source, native identity, session, type, payload and observed/controlled mode. Native tool requests and file-change notifications are observations. Gateway `tool.pending`, `tool.decided` and `tool.execution-decision` records describe a pre-execution interception decision; an allow does not establish execution success. Claude `PostToolUse`/`PostToolUseFailure` and Codex completion notifications are runtime-reported results, rather than Gateway claims. Even a native completion notification is evidence from that runtime, not independent validation of correctness. The activity view exposes payload and mode so humans can inspect this distinction.

## Complexity before and after

| Before | After |
| --- | --- |
| Finding and Decision knowledge types, required keys | Plain text work and Main entries |
| Workspace/folder/file/task scopes and impact scopes | Optional rooted affected-file references |
| Context commits, attachments and effective decision identities | Main entry revision history and work provenance |
| Merge request, review, conflict choices, approve, apply | One human accept/reject operation |
| Knowledge authority ranks and relevance scores | Human-governed Main versus unapproved branch work |
| Budget levels, inferred subscriptions and knowledge replacement sync | Current Main snapshot and durable lightweight retrieval |
| Key/body equality interpreted as conflicting knowledge | File evidence or explicit incompatibility, potential until human assessment |

Workspaces, agents, sessions, events, approvals and audit history remain supporting infrastructure, not new competing collaboration domains.

## SQLite migration and compatibility

Schema version 3 preserves the entity/event store and old tables. Version 1 first follows the existing version 2 migration, including initializing/adopting Main and preserving native event sequences. Version 2 to 3 projects accepted Main attachments into `main-entry` and `main-revision`; superseded old decisions remain removed historical entries. Accepted findings remain current. Local agent commits become `branch-work`, accepted only if actually attached to Main. Old pending merge requests and reviews confer no acceptance. They remain historical rows and have no active write API.

Migration records `legacyCommitId` and origin work links, retaining original immutable commits for exact provenance. `legacy-acceptance` marks acceptance inherited from the old model; it does not invent the original reviewer's identity. The retained `Workspace.mainBranchId` identifies the SQLite Main revision head for migration compatibility; public branch listings exclude it and native sessions cannot bind to it. Entry IDs use `legacy-main:<commitId>` and work IDs use `legacy-work:<commitId>`. Existing Main revision values are retained. Migration is transactional and runs once; SQLite backups remain advisable before upgrades. A future cleanup migration can remove archival governance tables only after a deliberate retention decision.

The old context commit, merge-request and review APIs/tools and CLI commands are intentionally replaced, not maintained as a second product model. Session/event/approval endpoints and credentials remain valid. New `supervision_ledger` rows replace the active delivery metadata; legacy `sync_ledger` rows and their cached replies remain archival and cannot replay into the new protocol. New writes do not use legacy knowledge tables. Restart or refresh configured native MCP hosts after upgrading to discover the replacement tools. There is no schema downgrade path.

## Native correction limitations

Claude Code and Codex can retrieve Main, work and corrections through their configured Agentree MCP server. Agentree does not assume an idle or busy native runtime will poll it, read it immediately or obey it. No unsolicited prompt injection, unsupported hot context replacement, autonomous retry or autonomous conflict resolution is added. The existing Codex App Server launcher can start native turns, but supervision does not use that capability to take over planning or recovery. Passive log observation does not offer a correction-delivery channel by itself. Human tool denial can return an explanation through existing supported interception mechanisms; it is still a tool decision, not a general prompt delivery guarantee.
