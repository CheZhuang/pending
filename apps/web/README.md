# Web Console

The Console is the human supervision UI, built with Vue 3, Vite, Naive UI, and Vue Router. Use Node.js 24+ for a consistent runtime with the backend.

| Page | Purpose |
| --- | --- |
| Overview | Discovered local Claude Code and Codex processes, managed sessions, metadata, activity, and supported actions |
| Main | Shared reference editing, change previews, removal, entry restoration, provenance, and history |
| Main history | Global revisions, historical comparisons, and whole-Main or entry restoration |
| Tasks | Submit instructions with optional Main context, inspect native delivery evidence, and request cancellation |
| Branches | Branch tree (Main + agent lanes, proposals and merges), proposals, file evidence, recent activity, acceptance/rejection, and corrections |
| Conflicts | Evidence, human reports, and explained conflict assessments |
| Activity | Event history and SSE, including observation and approval records |
| Approvals | Pending controlled tool calls and their outcomes |

## Run

From the repository root:

```sh
npm ci --prefix apps/web
npm --prefix apps/web run dev          # standalone mock preview
# or
npm --prefix apps/web run dev:live     # running local Gateway required
```

Open `http://localhost:5173/?api=mock` or `http://localhost:5173/?api=live` to select the mode explicitly. Otherwise selection uses the saved mode, then the Vite mode; Vite defaults to mock and built assets default to live. Mock records reset on reload.

For live setup, follow the [root quick start](../../README.md#quick-start). Built Console assets use same-origin REST and SSE requests to the Gateway, with no browser pairing step. Vite live mode (`npm run dev:live`) connects to `http://localhost:8787`; set `VITE_GATEWAY_URL` to override that endpoint. The Gateway must allow the Console origin.

## Verify and build

```sh
npm --prefix apps/web test
npm --prefix apps/web run build
npm --prefix apps/web run preview
```

`src/api/live.js` and `src/api/mock.js` provide the view-facing API. Gateway responses determine write success and revision checks; errors remain visible to the human. Main history and task dispatch use the [HTTP contracts](../../docs/GATEWAY_API.md). Historical previews are checked against the requested revision; older Gateways show an unsupported error. Task delivery is available only for connected managed Codex runners.

See [architecture](../../docs/ARCHITECTURE.md) for supervision rules and [verification](../../docs/SUPERVISION_VERIFICATION.md) for test coverage.

## Local agent discovery API (frontend contract)

Overview is available without a selected workspace and reads native process discovery from the local Gateway. The discovery endpoint is not yet present on `main`; the Console targets this mock-first contract for Person 2's implementation:

- `GET /v1/discovery/agents` returns `{ refreshedAt, agents, operations? }`.
- `POST /v1/discovery/refresh` returns the same shape after a discovery scan.
- Each agent has `id`, `runtime`, `status`, optional `process` (`pid`, `executable`, `startedAt`, `exitedAt`, `exitCode`), `cwd`, optional `workspace` (`id`, `name`, `association`), optional `session` (`id`, `state`, `label`), optional `activity` (`summary`, `observedAt`, `evidence`), and authoritative `capabilities` (`canInspectActivity`, `canDispatchTasks`, `canReviewApprovals`, `canStop`).
- `operations.canStartManagedAgent` gates the optional start controls. Starting uses `POST /v1/agents/managed` with `{ runtime, cwd? }`.

The UI labels cwd-based workspace matches as inferred, leaves unavailable metadata explicit, and only enables actions listed by the Gateway. Discovery does not imply session ownership or control. No login, pairing, or browser token is used; Gateway origin and access errors use the existing live API error display.

Until the discovery API is present, Overview explicitly shows registered managed sessions from the existing session registry. It does not claim to have scanned native processes in this fallback state.
