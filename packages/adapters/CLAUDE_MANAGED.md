# Claude Code managed integration

`runManagedClaude()` is the managed launcher seam. It registers a `claude-code` session with the Gateway, writes a short-lived settings file in the operating-system temp directory, starts Claude with `--settings <file>`, and passes `HARNESS_GATEWAY_URL` plus `HARNESS_SESSION_ID` to the child. It does not modify project or user Claude settings.

The settings file installs a `PreToolUse` command hook for every tool with a 120-second timeout. The hook reads Claude's JSON event from stdin, sends `tool_name`, `tool_input`, `session_id`, and `cwd` to `POST /v1/decide`, and waits up to 100 seconds. It emits no stdout when allowed. A denial returns `hookSpecificOutput.permissionDecision = "deny"` and `permissionDecisionReason` with a `[Harness]` prefix. Gateway/network failures deny by default; `HARNESS_FAIL_OPEN=1` is a development-only opt-in.

The launcher listens to `GET /v1/stream?after=<seq>` and terminates the child when it receives its own `session.killed` event. SIGTERM is escalated to SIGKILL after three seconds. Child exit is reported with `POST /v1/sessions/:id/end`; the temporary settings directory is removed in all exit paths.

## Gateway transport expected by this adapter

- `POST /v1/sessions` with `{ runtime: "claude-code", cwd, label }`, returning `{ sessionId, seq }` (or `{ id, currentSeq }`).
- `POST /v1/decide` with `{ sessionId, tool, input, nativeSessionId, cwd }`, returning `{ outcome: "allow"|"deny", by?, reason? }` or the equivalent `decision` field.
- `GET /v1/stream?after=<seq>` as SSE (`data: {json}`) or newline-delimited JSON events shaped `{ seq, type, sessionId }`.
- `POST /v1/sessions/:id/end` to close the registration.

These routes are a transport contract only; the current checkout's core does not yet implement an HTTP Gateway. The daemon must construct an MCP `AgentreeService` with the authenticated session binding and provide equivalent Gateway routes before this launcher can run end to end.

Claude Code's official hooks reference documents the PreToolUse fields (`session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`), JSON denial output, and per-hook timeout. Its settings guide documents `--settings` as a session-only override that does not write settings files: [Hooks reference](https://code.claude.com/docs/en/hooks), [Settings files and precedence](https://code.claude.com/docs/en/settings).
