# Supervision refactor verification

Verified on 2026-11-07 with Node.js 24.22.1. Work started from freshly fetched `origin/main` at `29da559` on `feature/agent-supervision`. Luna agents explored the existing flows, implemented the repetitive Console/integration changes and developed replacement tests. The primary agent made the domain/API/migration decisions and reviewed their implementation.

## Results

| Check | Result |
| --- | --- |
| `npm run typecheck` | Pass, including test sources |
| `npm run build` | Pass |
| `npm test` | 40 tests pass; Core, migration, Sync, MCP, CLI, native adapter, HTTP/SSE and demo coverage |
| `npm run demo` | Pass; two session-bound MCP clients, native observation fixtures, human correction and acceptance |
| `npm --prefix apps/web test` | 5 tests pass; mock supervision workflow and stale edit/removal safeguards |
| `npm --prefix apps/web run build` | Pass, Vue/Vite production bundle |
| `git diff --check` | Pass |

HTTP/native tests required local loopback networking outside this environment's restricted sandbox. The sandboxed Node process otherwise aborts before HTTP assertions with an internal callback assertion; the authorized loopback test run passes. This is not treated as a passing sandboxed run. Console dependencies were installed from its committed lockfile to run the production build. CI now runs the Console workflow tests and production build in addition to the backend checks; the hosted CI job itself has not been run in this local session.

## Acceptance scenarios

1. **Human Main expectation:** Core/HTTP tests create an expectation directly, preserve immutable revision history, reject agent writes and stale human writes. Both session-bound MCP clients in the demo retrieve the authoritative Main snapshot. Sync tests cover text updates and removals replacing the previous reference.
2. **Claude/Codex overlap:** native-shaped Claude tool inputs, Codex file-change notifications and normalized touches map to rooted files. Core and demo tests expose overlaps as potential conflicts. A regression verifies declared files and native observations use the same identity across nested roots. Read-only touches and unknown/outside paths do not create write evidence.
3. **Explicit Main incompatibility:** proposals cite current Main entry IDs, or humans report an incompatibility. Humans supply an assessment to confirm, resolve or dismiss; they can edit Main or record a branch-addressed correction. MCP retrieves the correction. Matching prose alone does not generate semantic conflict claims.
4. **Acceptance into Main:** a human accepts selected pending work records atomically, preserving source work links and updating Main for other sessions. Stale, duplicate/invalid and nonhuman decisions fail; rejection does not update Main. No Git operations or project-file writes are involved.
5. **Monitoring and native boundaries:** tests retain secure native session binding, event deduplication/restart replay, native request IDs, supported Codex approval callbacks, Claude pre-execution hooks, tool approvals/timeouts, kill requests versus observed exits, Console origin/cookie protection, audit history and resumable SSE.

The migration suite covers version 1 with and without an existing Main, version 2 upgrade, canonical legacy file paths, preservation of native event sequences and original immutable records, unaccepted legacy proposals, history immutability and database reopen without duplication. Sync tests verify durable retries/acknowledgments and that legacy delivery caches cannot replay into the replacement protocol.

The Console test suite covers Main creation/edit/removal/history, stale writes, acceptance, conflict assessment and preserved approvals. Separate regressions ensure an entry removed during editing cannot be recreated silently and an edit cannot move to another workspace. Production compilation covers every Vue view. This verification does **not** include browser-driven click automation.

## Review corrections incorporated

- Main sync uses replacement snapshots keyed by revision, so edits and removals are delivered.
- A new delivery-ledger namespace prevents old cached knowledge deltas from resurfacing.
- Native/declared files use canonical rooted identity; overlap remains potential evidence.
- Core authorization applies to MCP acknowledgment metadata as well as content reads.
- Main text-only edits retain file references; native branch listings exclude Main's internal revision head.
- Console edits retain their opening revision and entry identity through SSE refresh/removal; history responses are tied to the current selection/workspace.
- Activity labels distinguish observations, Gateway interception decisions and runtime-reported results. Approval does not claim successful execution.

## Limits and compatibility

Real authenticated Claude Code/Codex smoke runs were **not** executed in this refactor. The live smoke script now uses `work_propose` and the branch work endpoint; it requires installed/authenticated native runtimes. Native integration tests use deterministic transports, hooks, process fixtures and recorded event shapes.

Corrections are durable messages retrieved through configured native MCP. Agentree cannot guarantee an arbitrary running agent will poll, receive, follow or successfully implement a correction. Passive log observation has no delivery channel. No unsupported unsolicited native push or autonomous recovery was added. Tool denial reasons use the existing supported interception mechanisms.

Main sync snapshots are complete records and use an item-count bound, not a byte/token cap. Large projects may need later pagination; no ranking protocol was rebuilt. Native commands without structured file-change evidence may provide no attributable file changes. File overlap cannot establish semantic incompatibility, and explicit reports still require human judgment. Derived signals no longer leave with the 30-event activity window (overlap evidence uses each branch's full observed write history), and a human disposition is not reopened by new evidence for the same branches and file.

Old context-commit, merge-request and review routes/tools/commands are intentionally replaced. Restart/refresh configured MCP hosts after upgrading so native runtimes discover the new tools. Existing native credentials, event ingestion and approval/lifecycle data remain usable. SQLite version 3 retains old governance rows as archival evidence, never as a second active workflow. See [architecture and migration](ARCHITECTURE.md), [API](GATEWAY_API.md), and the [Console guide](../apps/web/README.md).
