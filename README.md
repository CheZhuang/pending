# Agentree — Shared Engineering Contract

## Project Overview

Agentree is a local-first, secure collaboration gateway for independent AI agents.

It connects existing CLI agents such as Claude Code and Codex, observes their native activities, and enables them to collaborate through scoped context sharing, logical branches, and human-governed merges.

Agentree is not a new agent runtime or orchestrator. Existing agents retain their own reasoning, tools, and session management.

## MVP Goals

1. Observe two existing CLI agent runtimes through native APIs, logs, or hooks.
2. Persist normalized activity events in SQLite.
3. Associate agents and sessions with independent logical branches.
4. Let agents publish structured context and retrieve relevant incremental updates.
5. Support context merge requests and human conflict resolution.
6. Enforce permissions on Gateway-managed operations, with auditable decisions.
7. Provide a CLI and MCP interface without a graphical frontend.

## Architecture

TypeScript, Node.js, pnpm workspace, SQLite, Zod, Vitest, and the official MCP TypeScript SDK.

The system uses a single local daemon with modular packages:

- `packages/contracts`: Shared types, validation schemas, errors, API contracts.
- `packages/core`: Workspace, Branch, Session, Context, Merge, Policy, Review.
- `packages/storage`: SQLite schema, migrations, persistence.
- `packages/adapters`: Native CLI agent integrations.
- `packages/mcp`: MCP interface exposed to agents.
- `packages/sync`: Scope matching, context delta and delivery.
- `apps/cli`: Human-facing CLI and daemon entry points.

## Core Principles

- Native-first integration: reuse supported APIs and existing session logs.
- Zero project pollution: store state in user-level application data, not project directories.
- Logical branches are independent of Git branches.
- Context commits are immutable, traceable and scoped.
- Workspace, Folder, File and Task determine context relevance.
- Human decisions govern conflicting authoritative changes.
- Agents can exchange findings without automatically turning them into authoritative instructions.
- Incremental context synchronization minimizes unnecessary model tokens.
- All Gateway-managed writes require authorization and audit records.
- Observed actions are not necessarily controlled actions.
- SQLite is the persistent source of truth for Agentree state.
- The MVP runs locally on macOS and Linux.

## Shared Data Semantics

- Workspace: collaboration boundary.
- Branch: independent logical context history.
- Session: native runtime session attached to a branch.
- Event: normalized record of observed or managed activity.
- Context Commit: structured knowledge with provenance.
- Merge Request: proposal to integrate selected commits into a target branch.
- Review: human decision on an operation or conflict.
- Scope: workspace, folder, file or task-based relevance and access target.
- Context Delta: incremental changes relevant to a session.

Context Merge is not Git Merge. Sharing a Finding does not automatically merge code or override an accepted Decision.

## Collaboration Rules

Each developer owns a separate implementation area. Changes to shared contracts require agreement across owners.

Prefer small, testable implementations and stable public APIs. Use mocks for unfinished modules so development can proceed in parallel.

Create a feature branch before implementation, commit coherent changes regularly, and run type checks and tests before integration.

Prioritize the working MVP over speculative abstractions or future features.

## Out of Scope

No graphical dashboard, Gemini CLI adapter, autonomous multi-agent orchestration, vector database, automatic semantic conflict resolution, full desktop accessibility, Git worktree management, distributed deployment or universal sandboxing.

## Definition of Done

Two real agent runtimes can join a workspace, generate observable events, share scoped context, and participate in human-governed merges.

At least one Gateway-managed operation must be genuinely authorized or denied before execution, with the result recorded in SQLite.

## Core foundation (Task A)

Requires Node.js 24+. Run `npm ci`, `npm run typecheck`, `npm test`, and
`npm run build`. The package layout is declared in `pnpm-workspace.yaml`;
this initial repository also retains its npm lockfile for existing workflows.
Tests currently use the Node test runner (no additional test dependency).

The daemon-facing `ApplicationService` and `AgentreeService` are exported from
`packages/core/src/index.ts`; shared Zod schemas and models are in
`packages/contracts/src/index.ts`. Construct `SqliteStore` with a database path
in the user's application data directory. See `packages/core/README.md` for the
trusted identity boundary, controlled operations, observed events, and review
semantics. This foundation does not wire the placeholder HTTP server to an
unauthenticated agent endpoint.

## Scoped sync, CLI and demo (Task C)

- `packages/sync`: scope relevance, inferred agent focus, and incremental context delivery (see its README).
- `apps/cli`: the human-facing `agentree` CLI: `npm run agentree -- --help`.
- `demo/`: a reproducible two-agent run of the full loop: `npm run demo` (see `demo/README.md`).
