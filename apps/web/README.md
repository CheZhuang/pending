# Agentree Web Console

The console is a human supervision surface for the local Gateway. It is built with Vue 3, Vite, Naive UI, and Vue Router.

| Page | What it shows |
| --- | --- |
| **Overview** | Logical branches, native sessions, lifecycle state, stop requests, and adapter-declared capabilities |
| **Main** | The shared human-maintained text reference, revisioned edits, removals, provenance, and per-entry history |
| **Branches** | Agent work proposals, reported file references, recent session activity, direct acceptance or rejection, and corrections |
| **Conflicts** | Potential and confirmed conflict evidence, human reports, and explained confirm, resolve, or dismiss decisions |
| **Activity** | Live events from history and SSE, with observed telemetry, runtime-reported results, intercepted decisions, and Gateway records distinguished |
| **Approvals** | Pending controlled tool approvals and their terminal outcomes |

Main is text guidance for agents. File references are evidence and labels; the Console does not edit source files or perform Git operations. Branches are logical work records, not Git branches. File overlap starts as potential evidence and does not itself establish incompatibility. Runtime-reported completion is not independent proof of correctness, and an intercepted tool decision is not proof the tool ran.

## Run it

Use Node 20.19+ or 22.12+ for the Console (the Gateway itself needs Node 24).

```bash
cd apps/web
npm install
npm run dev            # http://localhost:5173, mock data
```

## Mock mode

Mock mode mirrors the supervision records and API: Main entries and history, proposed branch work, conflicts, corrections, merges, session activity, and tool approvals. Changes reset when the page reloads.

Run the API workflow checks with `npm test`.

## Live mode

```bash
# terminal 1, repository root, Node 24+
npm ci && npm run build && npm start
```

```bash
# terminal 2
cd apps/web && npm run dev:live
```

The Console asks for the admin token once and pairs it through `POST /v1/console/login`. The token is never stored by the page; REST and SSE use the HttpOnly cookie. Open the Console on **localhost** to match the Gateway's default allowed origin. Change the Gateway URL with `VITE_GATEWAY_URL`.

## Build

```bash
npm run build && npm run preview
```

The live API adapter is in `src/api/live.js`; the in-browser implementation is in `src/api/mock.js`. Both expose the same methods. The Gateway is authoritative for writes and revision checks. The Console displays server errors instead of treating a local decision as successful.
