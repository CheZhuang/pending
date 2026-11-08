# Real-agent checks

Use [native setup](../docs/NATIVE_AGENTS.md) for launcher commands and supported controls. Live runs require locally installed, authenticated runtimes and may use model credits. Deterministic coverage is available through [the two-agent demo](README.md).

## Claude supervision rehearsal

1. Build the backend and start the Gateway and live Console as described in the [quick start](../README.md#quick-start).
2. Launch `demo/managed-claude.mjs` from a scratch project using the command in native setup. It registers a workspace, branch, and session automatically.
3. Ask Claude to read one file, propose a small change through `work_propose`, and retrieve Main using `context_sync`.
4. Review pending tool calls on **Approvals**. Approve or deny with a reason, and inspect the corresponding records on **Activity**.
5. Inspect the proposal on **Branches**, send a correction, and accept or reject the work. Inspect the resulting **Main** and history.
6. Request **Stop** on **Overview** and inspect the session's lifecycle report. A stop request and a reported process exit are distinct evidence.

Every controlled call requires a decision before the approval deadline. Keep the task small. Approval records alone do not prove execution or correctness.

## Isolated native smoke checks

```sh
npm run smoke:native -- claude
npm run smoke:native -- codex
```

Each command starts a temporary Gateway and prints an evidence path. Both check session binding, native observation, and a real MCP work proposal. The Codex smoke also submits a task through the dispatch API and waits for matching terminal native evidence. No preexisting Gateway is needed.

The smoke approval helper allows PendingTree MCP calls and literal reads of its synthetic fixture; other requested tools are denied. Save the printed evidence when reporting results. Fixture-based tests do not establish that these live checks passed on your machine.

## Real two-agent demo

Start the Gateway and live Console, then choose a model available to your authenticated Codex runtime:

```sh
CODEX_MODEL=<model> npm run demo:real -- --check
CODEX_MODEL=<model> npm run demo:real
```

Preflight checks dependencies and seeds the playground without model calls. The full run writes Main expectations, dispatches Codex work, launches Claude with a task, and waits for human conflict assessment, acceptance, and correction in the Console. A follow-up Codex task retrieves the correction and updated Main; the final step requests a human Stop.

Use Approvals for supported tool decisions, Branches for acceptance/corrections, Conflicts for assessment, Tasks for delivery evidence, and Main history for revision inspection and restoration.

`CODEX_MODEL` is required. Claude defaults to `haiku` (override with `CLAUDE_MODEL`). The playground defaults to `~/pendingtree-two-agents` (override with `PLAYGROUND`). The helper approves PendingTree MCP calls automatically; use `--manual` to review those too. Other controlled calls wait for human review. Live model behavior remains unverified by deterministic tests.

See [verification](../docs/SUPERVISION_VERIFICATION.md) for validation scope.
