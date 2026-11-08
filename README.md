# Agentree

Agentree is a local supervision layer for independent Claude Code and Codex agents. It gives humans a shared reference, visibility into native activity, and a way to assess conflicting work and send corrections. Native agents keep control of their own planning and execution.

## How it works

1. Write expectations in **Main**, the human-maintained shared reference.
2. Launch managed agents against a project. Each session belongs to a logical **Branch** containing activity, file references, and work proposals.
3. Inspect **Conflicts** and send branch-specific corrections. File overlap is potential evidence; humans decide whether work is incompatible.
4. Accept useful proposals into Main or reject them. Acceptance records conclusions and provenance; it does not merge Git commits or edit source files.

Agents retrieve Main and corrections through the configured MCP server. Retrieval and acknowledgment record delivery, not proof that an agent followed the guidance.

## Quick start

Use **Node.js 24+** and npm. Run these commands from the repository root:

```sh
npm ci
npm run build
npm start
```

The Gateway listens at `http://127.0.0.1:8787`. In another terminal, start the Console:

```sh
npm ci --prefix apps/web
npm --prefix apps/web run dev:live
```

Open **http://localhost:5173/?api=live** and pair with the admin token:

```sh
cat "${GATEWAY_DATA_DIR:-$HOME/.local/share/agentree}/admin-token"
```

Create a workspace and an initial expectation from the CLI, using an absolute project path:

```sh
npm run agentree -- init my-project --root project=/absolute/path/to/project
npm run agentree -- main add "Keep the public API backward compatible."
```

Then [launch Claude Code or Codex](docs/NATIVE_AGENTS.md). Managed launchers can also create a workspace and branch from the project directory. Use the Console's Main, Branches, Conflicts, Activity, and Approvals pages to supervise the session.

For a standalone Console preview, use `npm --prefix apps/web run dev` and open `http://localhost:5173/?api=mock`. For a deterministic two-agent workflow without native credentials or model calls, run `npm run demo`.

## Local configuration

| Setting | Default / purpose |
| --- | --- |
| `GATEWAY_DATA_DIR` | `~/.local/share/agentree`; Gateway database and generated admin token |
| `PORT` | `8787`; Gateway binds to `127.0.0.1` |
| `HARNESS_ADMIN_TOKEN` | Optional admin credential override (at least 32 characters); otherwise load or generate `admin-token` |
| `GATEWAY_CONSOLE_ORIGINS` | Comma-separated origins; defaults to `http://localhost:5173,http://127.0.0.1:5173` |
| `VITE_GATEWAY_URL` | Console build/dev setting; defaults to `http://localhost:8787` |

Keep the data directory and credentials private. Use the same data directory for the Gateway, CLI, and native launchers. The CLI has [additional state overrides](apps/cli/README.md). Native hosts need local access to the Gateway SQLite database for MCP.

## Development

The backend uses TypeScript and SQLite; the Console uses Vue and Vite. Backend dependencies are installed at the root, and Console dependencies separately in `apps/web`.

```sh
npm run dev                         # watch the Gateway source
npm run typecheck
npm test
npm run build
npm --prefix apps/web test
npm --prefix apps/web run build
npm run demo
```

See [verification](docs/SUPERVISION_VERIFICATION.md) for coverage and live smoke requirements. For the live two-agent demo and its runtime requirements, see [real-agent checks](demo/REAL_AGENTS.md).

## Documentation

- [Documentation index](docs/README.md): guides, references, and documentation ownership.
- [Native setup](docs/NATIVE_AGENTS.md) and [CLI](apps/cli/README.md): launch and inspect agents.
- [Console](apps/web/README.md): mock/live modes, pairing, and builds.
- [Gateway API](docs/GATEWAY_API.md), [Main history](docs/MAIN_API.md), and [task dispatch](docs/TASK_DISPATCH_API.md): HTTP contracts.
- [Architecture](docs/ARCHITECTURE.md) and [migration](docs/MIGRATION.md): domain behavior, module boundaries, and upgrades.
