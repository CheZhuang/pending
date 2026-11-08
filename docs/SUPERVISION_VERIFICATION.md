# Verification

Run commands from the repository root with Node.js 24+. Install backend dependencies with `npm ci` and Console dependencies with `npm ci --prefix apps/web`.

## Checks

| Command | Coverage |
| --- | --- |
| `npm run typecheck` | Backend source and test types |
| `npm test` | Core, migration, Sync, MCP, CLI, adapters, Gateway HTTP/SSE, tasks, and deterministic demo |
| `npm run build` | Backend production compilation |
| `npm run demo` | Two-session supervision walkthrough without model calls |
| `npm --prefix apps/web test` | Mock supervision workflow and Main edit/removal safeguards |
| `npm --prefix apps/web run build` | Vue/Vite production bundle |
| `git diff --check` | Patch whitespace |

CI runs backend typechecking, tests, and build plus Console tests/build. A local pass does not establish a hosted CI result.

## Latest local validation

Before pulling the latest Console changes, the documentation refresh on 2026-11-07 used Node.js 24.22.1. Typechecking, backend build, deterministic demo, Console tests on the pre-refresh base (2 test files), and Console build passed. The backend suite passed all 59 tests outside the restricted sandbox.

The sandboxed backend run aborted inside Node with an `InternalCallbackScope` assertion before usable test results. The successful rerun used local loopback networking outside that sandbox; the sandboxed attempt is not counted as passing. Documentation checks resolved local Markdown links and heading anchors and checked that prose is English.

After pulling `main` at `811bfd4`, the updated Console suite (6 test files) and production build also passed. Documentation was reconciled with the new history, task, and live-demo workflows.

## Behavioral coverage

- Human Main editing/removal, immutable entry/global history, historical preview, atomic restoration, provenance, stale revisions, and agent denial.
- Session-bound MCP retrieval of Main, sibling work, and targeted corrections; persisted retries and acknowledgment; delivery-cache isolation after migration.
- Rooted declared/native write overlap, nested roots, read-only/outside-path exclusion, durable evidence beyond the activity window, and retained human dispositions.
- Atomic work acceptance/rejection, explicit Main incompatibility, human conflict assessment, and corrections.
- Version 1/2 migration, restart persistence, legacy provenance, and event deduplication.
- Native request identity, supported approval callbacks, Claude hooks, stop requests versus reported exits, timeouts, Console cookies/origins, audit events, and resumable SSE.
- Durable task submission, retry identity, session isolation, cancellation, uncertain delivery, and matching native turn evidence. The managed Codex delivery test uses a fake App Server.
- Console Main workflows, acceptance, conflict assessment, and approvals, including edits invalidated by removal or workspace changes.

## Limits

No browser-driven click automation or real authenticated Claude/Codex smoke was run for this documentation refresh. Native fixture/process tests are deterministic integration evidence, not live model verification. Use [real-agent checks](../demo/REAL_AGENTS.md) for live smoke commands and evidence collection; the live two-agent demo requires authenticated runtimes.

Retrieval does not prove compliance, tool approval does not prove execution, and native completion does not prove correctness. File overlap is potential evidence. Full Main snapshots are bounded by item count rather than bytes/tokens. See [architecture](ARCHITECTURE.md) and [native controls](NATIVE_AGENTS.md#supported-controls) for these product boundaries.
