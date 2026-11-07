# Claude Code managed integration

`runManagedClaude()` is the managed launcher seam. It registers a `claude-code` session with the Gateway, writes a short-lived settings file in the operating-system temp directory, starts Claude with `--settings <file>`, and passes `HARNESS_GATEWAY_URL`, `HARNESS_SESSION_ID`, and the session-scoped `HARNESS_SESSION_TOKEN` to the child. It strips the admin token from the child environment and does not modify project or user Claude settings.

The settings file installs a `PreToolUse` command hook for every tool with a 120-second timeout. The hook reads Claude's JSON event from stdin, sends `tool_use_id` as the stable `requestId` when present (otherwise it generates one UUID for that hook invocation), and sends `tool_name`, `tool_input`, `session_id`, and `cwd` to `POST /v1/decide`. Retrying the same request must reuse its requestId. The hook waits up to 100 seconds. It emits no stdout when allowed. A denial returns `hookSpecificOutput.permissionDecision = "deny"` and `permissionDecisionReason` with a `[Harness]` prefix. Gateway/network failures deny by default; `HARNESS_FAIL_OPEN=1` is a development-only opt-in.

The launcher listens to `GET /v1/stream?after=<seq>` and terminates the child when it receives its own `session.kill-requested` event (also accepts legacy `session.killed`). SIGTERM is escalated to SIGKILL after three seconds. After observing the child `exit` event, the launcher reports `POST /v1/sessions/:id/end` with `{ exitCode, signal }`. A spawn error without an observed exit is not reported as a confirmed child exit. The temporary settings directory is removed in all paths.

## Gateway transport expected by this adapter

- `POST /v1/sessions` with admin bearer and `{ runtime: "claude-code", cwd, label }`, returning `{ sessionId, sessionToken, seq }` (or `{ id, currentSeq }`).
- `POST /v1/decide` with session bearer and `{ requestId, sessionId, tool, input, nativeSessionId, cwd }`, returning `{ outcome: "allow"|"deny", by?, reason? }` or the equivalent `decision` field.
- `GET /v1/stream?after=<seq>` as SSE (`data: {json}`) or newline-delimited JSON events shaped `{ seq, type, sessionId }`.
- `POST /v1/sessions/:id/end` with session bearer and observed child exit status `{ exitCode, signal }` to close the registration.

These routes are a transport contract. An allow/deny response records a policy decision; it is not proof that the child tool executed or was prevented from executing. Enforcement depends on the Claude pre-execution hook honoring the response.

Claude Code's official hooks reference documents the PreToolUse fields (`session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`), JSON denial output, and per-hook timeout. Its settings guide documents `--settings` as a session-only override that does not write settings files: [Hooks reference](https://code.claude.com/docs/en/hooks), [Settings files and precedence](https://code.claude.com/docs/en/settings).
