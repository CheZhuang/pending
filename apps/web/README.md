# Web Console

The Console is the human supervision UI, built with Vue 3, Vite, Naive UI, and Vue Router. Use Node.js 24+ for a consistent runtime with the backend.

| Page | Purpose |
| --- | --- |
| Overview | Managed sessions with their real controls, plus Claude Code and Codex processes discovered on this computer (metadata only); works without a workspace |
| Main | Shared reference editing, change previews, removal, entry restoration, provenance, and history |
| Main history | Global revisions, historical comparisons, and whole-Main or entry restoration |
| Tasks | Submit instructions with optional Main context, inspect native delivery evidence, and request cancellation |
| Branches | Branch tree (Main + agent lanes, proposals and merges), proposals, file evidence, recent activity, acceptance/rejection, and corrections |
| Conflicts | Evidence, human reports, and explained conflict assessments |
| Activity | A recent window of event history plus SSE, older events on demand, including observation and approval records |
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

## Local agents (Overview)

Overview reads two implemented Gateway APIs and needs no selected workspace:

- `GET /v1/processes` returns the Gateway's cached computer-wide `ProcessInventory` (`status`, `scannedAt`, `processes`, `message`); `POST /v1/processes/refresh` asks for a new OS scan. See [native discovery](../../docs/NATIVE_DISCOVERY.md). The Console polls the cached inventory every 10 s only while Overview is visible.
- `GET /v1/sessions` returns managed sessions with lifecycle and `taskDispatch.available`.

A process is linked to a managed session only through the Gateway's `managedSessionId` (launcher-reported identity). Unlinked processes are shown as metadata only, with no task, approval, or stop controls. For managed sessions, task dispatch follows `taskDispatch.available`; approval paths are the ones each integration declares (Claude Code pre-execution hook, Codex selected native callbacks) because the Gateway does not report per-session capabilities.

## Activity history

Selecting a workspace loads a recent window (about 200 events), then follows SSE from the newest sequence. "Load older events" reads further back on demand. The events route pages forward only (`after`, `limit`), and sequences are global across workspaces, so the Console reads sequence ranges below the newest one. Switching workspaces discards in-flight history pages, stream frames and view loads from the previous selection.
