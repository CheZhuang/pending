# Native adapters

Adapters bind registered native sessions to observed activity and supported execution controls. Start with [native setup](../../docs/NATIVE_AGENTS.md) for runnable commands and the enforcement matrix.

| Reference | Scope |
| --- | --- |
| [Interfaces](INTERFACES.md) | Identity, observation, cursor ingestion, and MCP boundaries |
| [Managed Claude](CLAUDE_MANAGED.md) | Launcher, hooks, lifecycle, and failure behavior |
| [Codex App Server](CODEX_APP_SERVER.md) | Low-level adapter, managed host, journal recovery, and approval callbacks |

Tests use fixtures and deterministic transports through root `npm test`. Real authenticated runtime checks are separate; see [real-agent checks](../../demo/REAL_AGENTS.md).
