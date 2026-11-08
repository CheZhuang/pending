# Web Console

The Console is the human supervision UI, built with Vue 3, Vite, Naive UI, and Vue Router. Use Node.js 24+ for a consistent runtime with the backend.

| Page | Purpose |
| --- | --- |
| Overview | Branches, native sessions, runtime capabilities, and stop requests |
| Main | Shared reference editing, change previews, removal, entry restoration, provenance, and history |
| Main history | Global revisions, historical comparisons, and whole-Main or entry restoration |
| Tasks | Submit instructions with optional Main context, inspect native delivery evidence, and request cancellation |
| Branches | Proposals, file evidence, recent activity, acceptance/rejection, and corrections |
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

Open `http://localhost:5173/?api=mock` or `http://localhost:5173/?api=live` to select the mode explicitly. Otherwise selection uses the saved mode before the Vite mode, then defaults to mock. Mock records reset on reload.

For live setup, follow the [root quick start](../../README.md#quick-start). Pair once using the admin token. The page does not persist that token; subsequent REST and SSE requests use the HttpOnly cookie. The default Gateway URL is `http://localhost:8787`. Set `VITE_GATEWAY_URL` when starting Vite or building to change it, and allow the Console origin in the Gateway configuration. Keep the Console and Gateway hostnames consistent for browser cookies.

## Verify and build

```sh
npm --prefix apps/web test
npm --prefix apps/web run build
npm --prefix apps/web run preview
```

`src/api/live.js` and `src/api/mock.js` provide the view-facing API. Gateway responses determine write success and revision checks; errors remain visible to the human. Main history and task dispatch use the [HTTP contracts](../../docs/GATEWAY_API.md). Historical previews are checked against the requested revision; older Gateways show an unsupported error. Task delivery is available only for connected managed Codex runners.

See [architecture](../../docs/ARCHITECTURE.md) for supervision rules and [verification](../../docs/SUPERVISION_VERIFICATION.md) for test coverage.
