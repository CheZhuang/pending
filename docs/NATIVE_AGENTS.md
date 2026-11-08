# Native agent integration

Follow the [quick start](../README.md#quick-start) to build and start the Gateway and Console with Node.js 24+. Install and authenticate each native runtime locally before launching it. Launchers register a session with the admin credential and configure Agentree MCP with a session credential. Keep credentials and native registration files private. Native MCP processes need access to the same local Gateway database.

## Claude Code

After building, run the wrapper from the project you want Claude to work in. Replace `/absolute/path/to/agentree` with this repository's path:

```sh
cd /absolute/path/to/project
node /absolute/path/to/agentree/demo/managed-claude.mjs --label "Claude"
```

The wrapper loads the admin token from the configured Gateway data directory unless `HARNESS_ADMIN_TOKEN` is set. Use `--gateway <url>` or `HARNESS_GATEWAY_URL` for a nondefault address. Additional Claude arguments follow `--`, for example `-- --model <model>`.

The launcher creates a fresh session with temporary pre/post-tool hooks and a session-bound MCP server, monitors stop requests, and reports the child exit. See [managed Claude implementation](../packages/adapters/CLAUDE_MANAGED.md) for hook behavior and configuration ownership.

## Codex App Server

`ManagedCodex.open` owns the App Server connection and registers its native thread ID. Run this example from the repository root after building; change `cwd` to the absolute project directory:

```sh
export HARNESS_ADMIN_TOKEN="$(cat "${GATEWAY_DATA_DIR:-$HOME/.local/share/agentree}/admin-token")"
node --input-type=module <<'JS'
import { resolve } from 'node:path';
import { ManagedCodex } from './dist/packages/adapters/src/codex-managed.js';
const native = await ManagedCodex.open({
  gatewayUrl: 'http://127.0.0.1:8787',
  databasePath: resolve(process.env.GATEWAY_DATA_DIR ?? resolve(process.env.HOME, '.local/share/agentree'), 'gateway.sqlite'),
  cwd: '/absolute/path/to/project', label: 'Codex',
});
try {
  console.log('Registration file:', native.registrationFile);
  const { turn } = await native.startTurn('Use Agentree context_sync to read relevant context.');
  console.log(await native.waitForTurn(turn.id));
} finally { await native.close(); }
JS
```

Review supported approval callbacks in the Console while the turn runs. `close()` ends the Gateway session. To reconnect after a host interruption while the session remains active, supply its private `registrationFile` as `resumeFile` with the same Gateway, project, and database options. See [Codex implementation](../packages/adapters/CODEX_APP_SERVER.md) for bootstrap, state paths, and recovery.

An active managed Codex host also polls the [task dispatch API](TASK_DISPATCH_API.md) for explicit human instructions. Existing Claude CLI sessions and arbitrary Codex Desktop conversations are not supported dispatch targets. Use the Console Tasks page to submit and monitor tasks.

## Supported controls

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

## Checks and troubleshooting

Run `npm run smoke:native -- claude` or `npm run smoke:native -- codex` for an isolated live check; see [real-agent checks](../demo/REAL_AGENTS.md) for prerequisites and evidence. Automated fixtures and live runtime evidence are documented separately in [verification](SUPERVISION_VERIFICATION.md).

| Symptom | Check |
| --- | --- |
| Startup fails on `node:sqlite` | Use Node.js 24+ |
| Missing token or empty workspace | Start the Gateway and use the same `GATEWAY_DATA_DIR` and database everywhere |
| Console pairing fails | Use the configured Console origin and consistent `localhost` hostnames; check `GATEWAY_CONSOLE_ORIGINS` |
| Launcher reports missing build | Run `npm run build` at the repository root |
| Hook immediately denies | Check Gateway reachability and session credential; transport failure denies by default |
| Agent tools run without Agentree approval | Check that the managed launcher is used and that this tool has a supported interception path |
| Main/correction does not affect agent behavior | The agent must retrieve context through MCP; delivery is not behavioral compliance |

The [MCP tool reference](../packages/mcp/README.md) lists reads and proposals. Main editing, work acceptance, and correction creation are human operations described in the [Gateway API](GATEWAY_API.md).
