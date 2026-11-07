# Agentree Web Console

A lightweight console for humans watching and governing agents. Vue 3 + Vite, plain JavaScript
(`<script setup>`), Naive UI, Vue Router. Dark by default, with a Catppuccin Frappé palette.

| Page | What it shows |
| --- | --- |
| **Overview** | Workspace and roots, logical branches, agent sessions with gateway state (`active` / `kill-requested` / `ended`), declared runtime capabilities, counts of pending work, and a **Stop** button (kill request) |
| **Activity** | Live event timeline (history + SSE): observed agent activity, policy decisions, tool approvals, merges. Filters for category, session, text and denials only, a pause toggle, and full payload per event |
| **Reviews** | Pending **tool approvals** (countdown, optional reason, Allow / Deny) and **context merge reviews** (incoming commits, conflicts side by side, a choice for each conflict, Approve / Resolve / Reject, then apply) |
| **Context** | **Branch tree** (main + agent lanes, findings and decisions colored by authority, applied / pending / rejected merges), per-branch context with authority labels, commit provenance and merge history |

## Run it

Use Node 20.19+ or 22.12+ for the console (the gateway itself needs Node 24).

```bash
cd apps/web
npm install
npm run dev            # http://localhost:5173, mock data
```

### Mock mode (default)

An in-browser stand-in for the gateway (`src/api/mock.js`) replays the two-agent demo story: Claude Code on
`claude-auth`, Codex on `codex-api`, one decision merged to main and a conflicting one waiting for review. It
keeps producing agent activity and new tool approvals. It enforces the same rules as the gateway:
- a review can only be decided once (`409 STATE`)
- a merge can only be applied after approval (`409 REVIEW`)
- tool approvals time out

Reloading the page resets it.

### Live mode (local gateway)

```bash
# terminal 1, repository root, Node 24+
npm ci && npm run build && npm start          # gateway on http://127.0.0.1:8787
```

```bash
# terminal 2
cd apps/web && npm run dev:live               # or open http://localhost:5173/?api=live
```

The console asks for the admin token once (`cat ~/.local/share/agentree/admin-token`). It sends the token to
`POST /v1/console/login`, which sets an 8-hour HttpOnly cookie. The token is never stored by the page. After
that, REST calls use `credentials: 'include'` and live updates use `EventSource(..., { withCredentials: true })`.
The browser resumes the stream with `Last-Event-ID`, so no event is missed or repeated.

- Open the console on **localhost** (not 127.0.0.1) so the gateway's SameSite cookie works. The gateway allows
  `http://localhost:5173` by default (`GATEWAY_CONSOLE_ORIGINS`).
- Point at another gateway with `VITE_GATEWAY_URL=http://localhost:9000 npm run dev:live`.
- Switch modes any time with the **MOCK / LIVE** tag in the header.

## Build

```bash
npm run build && npm run preview
```

## How it is put together

- `src/api/live.js` and `src/api/mock.js` expose the same methods; views only import `api` from
  `src/api/index.js`. Errors are `ApiError { status, code, message }`, shown with the gateway's code and a hint.
- `src/state.js` is a plain `reactive()` object (no store library). It holds the selected workspace, the event
  log, and change counters. Views reload when a matching live event arrives.
- Authority labels are imported from `packages/sync/src/authority.ts`, the same code that sync and the CLI use,
  so "finding / proposed / accepted / superseded" means the same thing everywhere.
- `src/components/BranchGraph.vue` draws the branch tree as plain SVG. There is no chart library.
- The gateway is the source of truth. The console shows real approval and review states and server errors,
  and never decides anything itself.

## Known limits

- The gateway does not report runtime capabilities. Overview shows what the adapters *declare*
  (Claude Code: pre-execution hook; Codex: observed, not intercepted).
- Sync delivery counts (pending / delivered / acknowledged per session) and the CLI's `relevant` preview are
  not exposed over HTTP yet, so the console does not show them.
- An approved tool call is a decision, not proof that the tool ran. The UI says so.
