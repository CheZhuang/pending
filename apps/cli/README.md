# agentree CLI

Human-facing supervision controls and read-only native activity inspection.
Every command supports `--json`; writes go through `AgentreeService` and are
authorized and audited.

```sh
npm run agentree -- --help
```

The CLI uses the same SQLite file as the Gateway (`$GATEWAY_DATA_DIR/gateway.sqlite`,
or `~/.local/share/agentree/gateway.sqlite`). Override it with `AGENTREE_HOME`
or `--db <path>`.

| Area | Commands |
| --- | --- |
| Workspace | `init`, `workspace show/list/use`, `status` |
| Native sessions | `branch list/create/show`, `session list/register`, `log` |
| Main | `main [show]`, `main add/edit/remove`, `main history` |
| Work | `work list/accept/reject <branch>`, `merge list` |
| Conflicts | `conflict list`, `conflict decide <id> <status> <explanation>` |
| Corrections | `correction send <branch> <body>` |

Branches are logical supervision records, not Git branches. Human acceptance
copies selected work text into Main and records its source work ID; it never
changes source files or invokes Git. File overlap creates only a potential
conflict. Humans record conflict decisions and explanations. Agent context
retrieval and acknowledgment do not show that the agent followed guidance.

`--as <session>` is a development/testing affordance for session identity.
Human Main, conflict and acceptance operations are denied to agents and appear
in the audit log.
