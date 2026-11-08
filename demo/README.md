# Deterministic supervision demo

From the repository root with Node.js 24+ and dependencies installed:

```sh
npm run demo
```

The demo uses temporary SQLite state and two authenticated MCP clients with simulated Claude/Codex activity. It needs no running Gateway, Console, native runtime, or model credentials and does not modify project files.

The scenario creates a workspace and session branches, replays rooted native observations, writes human Main guidance, and retrieves it with both MCP clients. Agents propose work with file evidence and an explicit Main incompatibility. A human assesses the potential conflict, sends a correction, accepts work into Main, and verifies the updated snapshot. An attempted agent Main edit is denied and audited.

See [real-agent checks](REAL_AGENTS.md) for live runtime rehearsal and the status of `demo:real`; see [architecture](../docs/ARCHITECTURE.md) for domain rules.
