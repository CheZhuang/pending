# Documentation

Start with the [project README](../README.md) for setup and the supervision workflow.

## Guides and references

| Document | Purpose |
| --- | --- |
| [Native agents](NATIVE_AGENTS.md) | Launch Claude Code or Codex and understand supported controls |
| [CLI](../apps/cli/README.md) | Local state, commands, and examples |
| [Web Console](../apps/web/README.md) | Pairing, mock/live modes, and builds |
| [Deterministic demo](../demo/README.md) | Reproducible supervision walkthrough |
| [Real-agent checks](../demo/REAL_AGENTS.md) | Live rehearsal and native smoke checks |
| [Gateway API](GATEWAY_API.md) | Authentication and REST endpoint map |
| [Main API](MAIN_API.md) | Revision checks, history, preview, and restoration |
| [Task dispatch API](TASK_DISPATCH_API.md) | Human-submitted native tasks and delivery states |
| [Architecture](ARCHITECTURE.md) | Domain rules, ownership, and evidence boundaries |
| [Migration](MIGRATION.md) | SQLite upgrades and retired protocols |
| [Verification](SUPERVISION_VERIFICATION.md) | Checks, coverage, and validation limits |

## Package references

[Contracts](../packages/contracts/README.md), [Core](../packages/core/README.md),
[Storage](../packages/storage/README.md), [Sync](../packages/sync/README.md),
[MCP](../packages/mcp/README.md), and [Adapters](../packages/adapters/README.md).

## Keeping documentation concise

Keep setup and the product overview in the root README. Put HTTP contracts in API references, domain behavior in architecture, and implementation details beside the owning package. Link to the owning document instead of repeating its explanation. Document behavior present in source; label historical plans and unverified runtime checks explicitly.

The [supervision refactor plan](SUPERVISION_PLAN.md) is historical context, not the current feature specification.
