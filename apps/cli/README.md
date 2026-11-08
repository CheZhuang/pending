# PendingTree CLI

The CLI provides local human supervision commands and native activity inspection. It calls Core directly against SQLite; it does not need a running HTTP Gateway.

```sh
npm run pendingtree -- --help
npm run pendingtree -- init my-project --root project=/absolute/path/to/project
npm run pendingtree -- main add "Preserve public API compatibility." --file project=src/api.ts
npm run pendingtree -- status
npm run pendingtree -- log --audit
```

Run from the repository root with Node.js 24+ and root dependencies installed.

## Commands

| Area | Commands |
| --- | --- |
| Workspace | `init <name>`, `workspace show/list/use`, `status` |
| Branches | `branch list/create <name>/show <branch>` |
| Sessions | `session list`, `session register <branch> --agent <id> --runtime <runtime> --native <id>` |
| Activity | `log [--session id] [--type type] [--source source] [--audit] [--after seq] [--limit n]` |
| Main | `main [show]`, `main add <body>`, `main edit <entry-id> <body>`, `main remove <entry-id>`, `main history <entry-id>` |
| Work | `work list <branch>`, `work accept/reject <branch> <work-id...>`, `merge list` |
| Conflicts | `conflict list`, `conflict decide <id> <confirmed/resolved/dismissed> <explanation>` |
| Corrections | `correction send <branch> <body>` |

All commands support `--json`; IDs generally accept unique prefixes. `context <branch>` is an alias for `branch show`. Native launch, tool approval, task dispatch, and Main restoration use their [native](../../docs/NATIVE_AGENTS.md) or [HTTP](../../docs/GATEWAY_API.md) interfaces; they are not CLI commands.

## State and identity

Database selection is `--db <path>`, then `gateway.sqlite` under `PENDINGTREE_HOME`, `GATEWAY_DATA_DIR`, or `~/.local/share/pendingtree`, in that order. The selected workspace is kept in `cli.json` under the CLI home. Override it with `--workspace <name-or-id>` or `PENDINGTREE_WORKSPACE`.

Human identity uses `PENDINGTREE_USER` or the operating-system username. Direct database access is a trusted local boundary. `--as <session>` is for development/testing; Core denies that actor human-only operations. Writes are authorized and audited, and Main writes use the current global revision.

Use the same database as the Gateway to see the same records in the Console. Acceptance copies work into Main with provenance. See [architecture](../../docs/ARCHITECTURE.md) for domain behavior.
