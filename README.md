# Agentree

Agentree provides overview, supervision, and correction of independent coding agents. Claude Code and Codex keep their own reasoning, planning, execution and recovery. Agentree observes their work and gives humans a shared reference and correction channel.

The workflow is: write expectations in **Main**, inspect agent **Branches**, assess **Conflicts**, accept useful work into Main, and communicate corrections. A branch is a logical work record containing native sessions, activity, file references and proposals. It is not a Git branch or a separate filesystem. A merge accepts work records and conclusions into Main; it never merges Git commits or changes project files.

Use Node.js 24+: `npm ci && npm run build && npm start`. The Gateway listens on `127.0.0.1:8787`. See [Gateway API](docs/GATEWAY_API.md) and [native setup](docs/NATIVE_AGENTS.md). Start the Vue Console with `cd apps/web && npm ci && npm run dev:live`, then pair with the local Gateway. Main editing, branch inspection, conflict disposition, corrections and tool approvals are human workflows in the Console.

Validate with `npm run typecheck`, `npm test`, `npm run build`, `npm run demo`, and `npm --prefix apps/web run build`. The deterministic demo exercises two authenticated MCP clients; real native runs require locally installed runtimes and credentials.

See [architecture, ownership and migration](docs/ARCHITECTURE.md), the [pre-implementation plan](docs/SUPERVISION_PLAN.md), and [verification report](docs/SUPERVISION_VERIFICATION.md).
