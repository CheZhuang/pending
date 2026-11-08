# Native agent integration

Use Node.js 24 or newer and run `npm ci && npm run build && npm start` from the repository root. Gateway listens on `127.0.0.1:8787` and creates its database and admin token in `~/.local/share/agentree/` unless `GATEWAY_DATA_DIR` is set. Keep that directory private. The launchers use the admin token only to register a native session; child processes receive a session credential instead.

## Claude Code

Install and authenticate Claude Code on the machine that runs it. In another terminal, from the repository root:

```sh
export HARNESS_ADMIN_TOKEN="$(cat ~/.local/share/agentree/admin-token)"
node --input-type=module -e 'import { runManagedClaude } from "./dist/packages/adapters/src/claude-launcher.js"; process.exitCode = await runManagedClaude({label:"Claude",gatewayUrl:"http://127.0.0.1:8787"});'
```

The launcher registers a Gateway session, allocates the Claude native session ID, installs PreToolUse, PostToolUse, and PostToolUseFailure hooks through temporary settings, configures the session-bound Agentree MCP server, listens for Gateway kill requests, and reports the observed child exit. Tool retries use Claude's `tool_use_id`. PreToolUse asks Gateway before execution and denies on transport failure. The MCP process rechecks its session credential before each operation.

The teammate with Claude Code can run `npm run smoke:native -- claude` from the repository root after `npm ci`; this starts an isolated temporary Gateway, runs the real Claude launcher and checks that the agent proposed branch work through MCP. The smoke does not need a preexisting Gateway. Save the printed evidence path and send the result back to the integration owner. This smoke has not been run on a Claude-equipped machine yet.

## Codex App Server

Install and authenticate `codex` and use a Node.js 24 runtime. `ManagedCodex.open` owns the App Server connection and registers its native thread ID with Gateway. Example from the repository root after building:

For normal use, the repository includes a short runner command. Start the Gateway in one terminal, then run this from the Agentree repository in another (set `--cwd` to the project Codex should work in):

```sh
npm run codex:managed -- --cwd /absolute/path/to/your/project
```

It reads the local admin token, registers a managed Codex session, and prints its session ID. Keep the terminal open; `Ctrl+C` ends the session. In a third terminal, submit and inspect tasks without constructing REST requests:

```sh
npm run task -- submit --session <session-id> --instructions "Review the login flow and report one concrete issue." --include-main
npm run task -- list --session <session-id>
npm run task -- status <task-id>
npm run task -- cancel <task-id>
```

The helper commands use the same default data directory as the Gateway. For a custom Gateway, set `AGENTREE_GATEWAY_URL`; for a custom data directory, set `GATEWAY_DATA_DIR` for both Gateway and helper processes. `npm run codex:managed -- --help` and `npm run task -- --help` show all options.

The lower-level API remains available through `ManagedCodex.open`:

```sh
export HARNESS_ADMIN_TOKEN="$(cat ~/.local/share/agentree/admin-token)"
node --input-type=module <<'JS'
import { resolve } from 'node:path';
import { ManagedCodex } from './dist/packages/adapters/src/codex-managed.js';
const native = await ManagedCodex.open({
  gatewayUrl: 'http://127.0.0.1:8787',
  databasePath: resolve(process.env.HOME, '.local/share/agentree/gateway.sqlite'),
  cwd: process.cwd(), label: 'Codex',
});
try {
  console.log('Registration file:', native.registrationFile);
  const { turn } = await native.startTurn('Use Agentree context_sync to read relevant context.');
  console.log(await native.waitForTurn(turn.id));
} finally { await native.close(); }
JS
```

The first Codex thread runs a restricted initialization turn with tools disabled because this App Server version cannot resume a new thread before its first turn. It then registers the actual native thread ID, reopens the persisted thread with the session-bound MCP configuration, and starts durable observation. The registration file has mode `0600`; protect it as a session credential. `ManagedCodex.open({...same options, resumeFile: path})` reconnects an active session and replays unacknowledged observations from the journal. A normal `close()` ends the logical Gateway session; it cannot then be resumed.

Run `npm run smoke:native -- codex` for an isolated real Codex smoke. The test expects an authenticated Codex App Server and checks registration, native turn completion, Gateway-approved MCP work proposal, and Core branch visibility.

## What the integration enforces

| Runtime / operation | Observed by Agentree | Gateway decision before execution |
| --- | --- | --- |
| Managed Claude PreToolUse | Yes, stable tool-use identity | Yes, hook denies on Gateway failure |
| Managed Claude PostToolUse / failure | Yes, stable tool-use identity | Already executed; observational only |
| Managed Claude Agentree MCP tools | Yes, through Core records | Session credential and Core authorization |
| Managed Codex App Server notifications | Yes, durable journal and Gateway deduplication | Observational only |
| Codex command execution and file change approval callbacks | Yes, when App Server emits callback | Yes, callback maps allow/deny to one request |
| Codex Agentree MCP approval elicitation | Yes, when App Server emits callback | Yes, request is sent to Gateway; each MCP operation also authenticates |
| Other Codex tools and unsupported callbacks | Only if App Server reports them | No general interception guarantee |

The Codex adapter does not turn every native tool into a Gateway-controlled operation. It reports `preExecutionInterception: false` for the adapter as a whole. Gateway controls only the supported callbacks above; ordinary notifications are evidence, not proof of pre-execution enforcement. Session identity comes from the registered runtime connection and credential, never from MCP tool arguments.

## Validation

`npm run typecheck`, `npm test`, and `npm run build` cover the codebase. The MCP → Core → Sync → MCP integration is covered by the MCP integration tests, including current Main snapshots, corrections, retries, acknowledgments and persisted retrieval. The supervision refactor is verified with deterministic native integration fixtures; live Claude/Codex smoke requires local runtime credentials and is not implied by those tests.

## Supervision context and corrections

The configured Agentree MCP server exposes current human-governed Main, branch work and branch-addressed human corrections. Agents submit plain-text work proposals with optional affected files and native event references. Humans edit Main directly and accept or reject proposals in the Console. A merge accepts records and conclusions; Git continues to manage source control.

Retrieval and acknowledgment do not prove an agent followed a correction. There is no unsolicited push into an arbitrary running native session. Passive logs alone cannot deliver messages; the agent must use its configured MCP tools. Tool denials can include a correction reason through the existing native interception path.
