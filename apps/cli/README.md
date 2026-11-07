# agentree CLI (Task C)

Human-facing CLI for inspecting agent activity and governing context merges.
No GUI. Every command takes `--json` (`{ ok, data }` or `{ ok: false, error: { code, message, hint } }`).

```bash
npm run agentree -- --help          # requires Node 24+
```

State lives in the user's application data directory (`~/Library/Application Support/agentree`
on macOS, `$XDG_DATA_HOME/agentree` on Linux), never in the project. Override with
`AGENTREE_HOME` or `--db <path>`. The human identity is `AGENTREE_USER` or the OS user name.

## Commands

| Area | Commands |
| --- | --- |
| Workspace | `init <name> [--root id=path]`, `workspace [show\|list\|use]`, `status` |
| Agents | `branch list\|create`, `session list\|register` |
| History | `log [--session] [--type] [--audit] [--after] [--limit]`, `context <branch> [--history]` |
| Relevance | `relevant <session> [--level] [--budget] [--fresh]`: preview the next sync without delivering it |
| Review | `merge list\|show\|create\|apply`, `review list\|show\|approve\|reject\|resolve` |

`review resolve <id> --keep incoming|existing` or `--pick <n>=existing|incoming` picks a side for each
conflict. Approve and resolve apply the merge immediately unless `--no-apply` is given.

## Authorization

All writes go through A's `AgentreeService`, so the gateway authorizes and audits them. The CLI
never writes SQLite directly. `--as <session>` acts as a registered agent session (for demos and
tests). For example, `agentree --as x-1 review approve <id>` is refused by the gateway, exits with
code 3, and is recorded as `policy.decision … DENY` in `agentree log`.

Exit codes: `0` ok · `1` failure · `2` usage · `3` not authorized · `4` not found · `5` stale or conflicting state.

## Known gap (needs A)

`ApplicationService` has no list methods for workspaces, sessions, merges or reviews yet. Until it
does, `gateway.ts` reads them from the entity table. Those reads are read-only and run only after an
authorized `workspace()` read. They are marked `TODO(A)` so they can be swapped for real service methods.
