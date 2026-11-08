# Runbook: Agentree with real agents

How to run Agentree with a **real Claude Code** session: watch its traffic live, approve or block
tool calls before they run, and stop it. This is also the **A10 Agent Harness demo**:

> launch a CLI agent → show its traffic live → block a disallowed operation → terminate the run.

Everything below was rehearsed against the real gateway, launcher and hook. The `claude` binary was
replaced by a stand-in that sends real `PreToolUse` payloads, so the steps match exactly except for
Claude's own UI.

## What works with real runtimes today

Updated after B's PR #16 (`docs/NATIVE_AGENTS.md` has the full enforcement matrix):

| Capability | Claude Code | Codex |
| --- | --- | --- |
| Joins a workspace as a governed session | ✅ `demo/managed-claude.mjs` (B's launcher) | ✅ `ManagedCodex` (B) |
| Tool calls allowed / denied by a human **before** they run | ✅ `PreToolUse` hook → `/v1/decide` | ⚠️ only command-execution, file-change and Agentree MCP approval callbacks; no general interception |
| Live traffic in the console and CLI | ✅ pre- and post-tool records | ✅ App Server notifications (journalled) |
| Stop (terminate the run) | ✅ console **Stop** → SIGTERM → exit reported | ✅ Stop revokes the session; the managed thread closes |
| Publish and sync context, merges (Agentree MCP) | ✅ session-bound MCP configured by the launcher | ✅ session-bound MCP configured by `ManagedCodex` |

**The main demo, Claude Code and Codex working together, is `npm run demo:real`** (section 9). Steps 1–8
below cover a single governed Claude session, which is the A10 harness part. `npm run demo` remains the
deterministic fallback with simulated agents.

**Not verified yet:** a real Claude Code run with Agentree MCP (B's Codex smoke passed; the Claude smoke
`npm run smoke:native -- claude` still needs a machine with Claude Code), and `npm run demo:real` end to end.
| Joins a workspace as a governed session | ✅ `demo/managed-claude.mjs` (B's launcher) | ❌ no launcher host yet |
| Tool calls allowed / denied by a human **before** they run | ✅ `PreToolUse` hook → `/v1/decide` | ❌ approvals not routed (adapter declines them) |
| Live traffic in the console and CLI | ✅ one record per tool call (policy, pending, decision) | ❌ until a host pushes App Server events |
| Stop (terminate the run) | ✅ console **Stop** → SIGTERM → exit reported | ❌ |
| Retrieve Main / corrections and propose branch work (MCP tools) | ✅ session-bound host is configured | ✅ session-bound host is configured |

For the **supervision loop** (Main, proposed work, explicit conflict evidence and human correction) use
`npm run demo`. It runs the same sync, MCP, gateway and CLI code with two simulated agents (see `README.md`).
The gaps above and who owns them are listed at the end.

---

## 0. One-time setup

1. **Node 24+** for the repo (the gateway uses `node:sqlite`). Check with `node -v`; with nvm: `nvm install 24 && nvm use 24`.
2. **Claude Code**, installed and logged in. Run it once on its own so it is authenticated:
   ```bash
   npm install -g @anthropic-ai/claude-code
   ```
   ```bash
   claude
   ```
3. **Build the repo and install the console:**
   ```bash
   npm ci && npm run build
   ```
   ```bash
   npm --prefix apps/web install
   ```
4. **A scratch project for Claude to work in.** Not the Agentree repo: Agentree writes nothing into it, but
   Claude will.
   ```bash
   mkdir -p ~/agentree-playground && cd ~/agentree-playground && git init && echo "# Playground" > README.md
   ```

**Rehearsal tip:** to start from a clean state each time, run `export GATEWAY_DATA_DIR=$(mktemp -d)` once and
then use that same shell value in *every* terminal below. Without it, all state lives in `~/.local/share/agentree`.

## 1. Start the gateway (terminal 1, repo root)

```bash
npm start
```

Expected: `Gateway listening on http://127.0.0.1:8787; admin credential: …/admin-token`. Leave it running.

## 2. Open the console (terminal 2)

```bash
npm --prefix apps/web run dev:live
```

Open **http://localhost:5173**. Use `localhost`, not `127.0.0.1`, otherwise the pairing cookie is refused.
Paste the admin token when asked:

```bash
cat ~/.local/share/agentree/admin-token
```

It shows "No workspace yet" until step 3. Reload the page after Claude starts.

## 3. Launch Claude Code under the gateway (terminal 3)

```bash
cd ~/agentree-playground
```

```bash
node /path/to/pending/demo/managed-claude.mjs --label "Claude A"
```

What happens:
- The gateway creates a workspace rooted at `~/agentree-playground`, a logical branch `Claude A` and a session.
- Claude starts with a temporary `--settings` file that adds the Agentree `PreToolUse` hook for this run only.
  Your Claude settings and the project are not modified.
- The admin token is removed from Claude's environment. Claude only gets its own session token.

Reload the console. **Overview** now shows the session as `active`.

Extra arguments go after `--` and are passed to `claude` (for example `-- --model sonnet`).

## 4. Give Claude a small task, and govern it

Suggested prompt (it triggers a few safe tool calls and one you will block):

> Read README.md, add a line "hello from Claude" to it, then run `git push --force`.

For **every** tool call (Read, Edit, Bash, …):
- **Reviews → Tool approvals** shows the call with a **60-second countdown**. Claude waits.
- Click **Allow** and Claude continues. Click **Deny** (optionally with a reason) and Claude receives
  `[Harness] Blocked by Gateway: <reason>` and does not run the tool.
- No decision within 60 s counts as **deny** (`timeout`).
- **Activity** shows each call live: `policy.decision → REQUIRE-APPROVAL`, `tool.pending`, `tool.decided`,
  `tool.execution-decision`.

Block the `git push --force`. That is the "block a disallowed operation" step.

> In this MVP the gateway asks a human about every tool call, Read included, so keep the task small.
> An approval is a decision sent to the hook, not proof that the tool ran.

## 5. Stop the run

**Overview → Stop** on the session, then confirm. Terminal 3 prints a red `已被管理员终止` ("stopped by the
administrator") and Claude exits. The session becomes `ended` with process status `exit-reported` (signal
`SIGTERM`), and any pending approvals of that session are denied.

## 6. The same story from the CLI

All three tools share the gateway's database:

```bash
npm run agentree -- status
```

```bash
npm run agentree -- log --audit
```

The log reads like this (from the rehearsal):

```
#8   policy.decision          agent:0ea0a354 controlled.execute → REQUIRE-APPROVAL (Human approval required)
#9   tool.pending             Bash npm test · waiting for a human
#10  tool.decided             approval 9bfa54f3 → approved by local-admin
#11  tool.execution-decision  hook told ALLOW for approval 9bfa54f3
#13  tool.pending             Bash git push --force · waiting for a human
#14  tool.decided             approval 4049c095 → denied (Force-push needs a human) by local-admin
#15  tool.execution-decision  hook told DENY for approval 4049c095
#16  session.kill-requested   stop requested by a human
#17  session.exited           process exited by SIGTERM
```

## 7. Two real sessions at once

Run step 3 again in another terminal from the same directory with a different label
(`--label "Claude B"`). The gateway reuses the workspace (same root) and creates a second branch, so two
independent, governed Claude Code sessions appear side by side in Overview, Activity and the branch tree.

## 8. Judge demo, about 3 minutes

1. Console Overview, then terminal 3 launches Claude → the session appears.
2. Give the prompt from step 4. Allow the Read and the Edit; the Activity page fills up live.
3. **Deny** `git push --force` with a reason → Claude reports it was blocked.
4. **Stop** → the session ends, and the terminal shows the termination.
5. `npm run agentree -- log --audit`: the auditable record of every decision.
6. Then the multi-agent part: `npm run demo:real` (section 9) with Claude Code and Codex together, shown on the
   console's **Reviews** and **Context** pages. Fallback: `npm run demo` with simulated agents.
6. Then `npm run demo` for the multi-agent part: current Main, branch proposals,
   the conflict signal, and a human acceptance/correction.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `npm start` fails on `node:sqlite` | Node < 24. Switch to Node 24. |
| Console: `DENY · Console origin is not allowed` | Open `http://localhost:5173` (not 127.0.0.1), or add your origin to `GATEWAY_CONSOLE_ORIGINS`. |
| `No admin token` from `managed-claude.mjs` | Gateway not started yet, or it uses a different `GATEWAY_DATA_DIR` than this terminal. |
| `Build the repository first` | Run `npm run build` in the repo (the launcher runs from `dist/`). |
| Claude runs tools without asking | It was started as plain `claude`. Only sessions launched through `managed-claude.mjs` are governed. |
| Every tool call is denied immediately | The hook cannot reach the gateway, so it denies by default. Check terminal 1. (`HARNESS_FAIL_OPEN=1` is for development only.) |
| `Gateway event stream failed; stopping managed session` | The gateway stopped. The launcher stops Claude rather than run ungoverned. |
| CLI or console shows an empty workspace | They use a different data directory. Use the same `GATEWAY_DATA_DIR` everywhere. |

## 9. Claude Code and Codex together (the main demo)

`demo/real-two-agents.ts` drives the same story as `npm run demo`, with real runtimes on the running gateway,
so everything appears live in the console:

1. **Codex** joins on branch `Codex` (owns `src/api`), subscribes to `src/api`, reads `src/api/users.ts` and
   publishes a Finding located in `src/api/users.ts` whose **impact scope** is `src/auth`.
2. **Claude** joins on branch `Claude` (owns `src/auth`), subscribes to `src/auth`, calls `context_sync` and
   receives Codex's Finding through the impact scope. It publishes the decision `token-ttl = 15 minutes` and
   sends a merge request to main. Then it tries `git push --force`, which **you deny** in the console.
3. **Codex** proposes the conflicting `token-ttl = 60 minutes` and requests a merge.
4. **You** resolve the conflict in **Reviews** (pick a side, Resolve & apply).
5. Both agents `context_sync` again and report the accepted decision.
6. **You** press **Stop** on the Codex session (terminate the run).

**Token cost is kept minimal on purpose:**
- Claude runs on `haiku` (override with `CLAUDE_MODEL`) with `--max-turns 10` and `--strict-mcp-config`, so only
  the Agentree MCP server is loaded.
- Codex **refuses to start unless `CODEX_MODEL` is set explicitly**, so it can never fall back to the default
  model. Set it to the cheapest model your Codex offers (see the model picker in `codex`). Reasoning effort is
  forced to `low`, and your other MCP servers are not loaded.
- The project is three tiny files, and every prompt says not to explore or edit other files.

The script auto-approves only **Agentree MCP** tool calls (collaboration plumbing). Every other tool call
(Bash, Read, Edit, Codex commands) waits for you in the console. Use `--manual` to approve the MCP calls by
hand as well.

```bash
npm start                                    # terminal 1
```

```bash
npm --prefix apps/web run dev:live           # terminal 2, open http://localhost:5173
```

```bash
CODEX_MODEL=<cheapest model> npm run demo:real -- --check    # terminal 3: preflight, no model calls
```

```bash
CODEX_MODEL=<cheapest model> npm run demo:real
```

`--check` verifies Node 24, the gateway, the admin token, the `claude` and `codex` commands and `CODEX_MODEL`,
and seeds the project (default `~/agentree-two-agents`, override with `PLAYGROUND`), without sending
anything to a model.

The real models may not follow the prompts exactly. Rehearse once, record the successful run as a backup
video, and keep `npm run demo` as the fallback.
## Missing for the full real-agent loop

1. **Codex launcher host (B).**
   - Register a `codex` session (`POST /v1/sessions`).
   - Start `CodexAppServerAdapter.start({ cwd })` and `startTurn(prompt)`.
   - Push `readEvents` batches to `POST /v1/events` with the session token, saving the cursor in `SqliteCursorStore`.
   - Map Stop to `interruptTurn` / `close`.

   Codex tool approvals are not intercepted; the gateway does not claim to control them.
3. **Claude transcript observation (B).** Ingest Claude Code's session JSONL so messages and non-tool activity
   show up too. Today only hook-gated tool calls are recorded.
