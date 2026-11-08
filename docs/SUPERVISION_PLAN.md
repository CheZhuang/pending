# Supervision refactor plan (historical)

This plan records the completed transition from ranked knowledge and staged reviews to human-governed supervision. Use [architecture](ARCHITECTURE.md) for current behavior, [migration](MIGRATION.md) for compatibility, and [verification](SUPERVISION_VERIFICATION.md) for checks.

The refactor retained workspaces, rooted files, logical branches, authenticated native sessions, durable observations, tool approvals, lifecycle records, SQLite transactions, and audit history.

It replaced finding/decision commits, required scopes and keys, knowledge ranking, and separate review/apply stages with:

- Plain-text Main entries with human authority, revision checks, and retained history.
- Branch work proposals with optional files and native evidence.
- Potential conflict signals assessed by humans.
- Atomic acceptance or rejection of selected work records.
- Branch-addressed corrections retrieved through session-bound MCP.

Acceptance records conclusions and provenance. Source control, native planning, and recovery remain outside this refactor. Later additions, including Main restoration and explicit native task dispatch, are documented in their API references rather than this historical plan.
