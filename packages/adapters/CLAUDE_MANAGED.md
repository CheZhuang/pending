# Managed Claude Code

`runManagedClaude()` in [src/claude-launcher.ts](src/claude-launcher.ts) registers a fresh `claude-code` session, allocates its native ID, and launches Claude with temporary hook settings and Agentree MCP configuration. See [native setup](../../docs/NATIVE_AGENTS.md) for the user-facing command.

The trusted launcher reads the local human capability file to register the session. The child receives `HARNESS_GATEWAY_URL`, `HARNESS_SESSION_ID`, and only its session token; the human capability is never placed in its environment. The launcher owns `--settings`, `--session-id`, and `--mcp-config`; conflicting resume/configuration flags are rejected. It removes temporary files on cleanup without editing project or user settings. This does not isolate a child with the same OS-user access to the capability file or database; see [the local security model](../../docs/LOCAL_SECURITY.md).

## Hooks

The settings install `PreToolUse`, `PostToolUse`, and `PostToolUseFailure` hooks. Pre-tool requests use `tool_use_id` as the stable decision request ID when available; otherwise one UUID is generated for that invocation. Retries must retain that ID. The hook sends the tool, input, native session, and working directory to `/v1/decide` with the session credential.

The pre-tool hook waits up to 100 seconds within its 120-second hook timeout. An allow produces no stdout. A denial emits `hookSpecificOutput.permissionDecision: "deny"` with a `[Harness]` reason. Transport failures deny by default; `HARNESS_FAIL_OPEN=1` is a development-only override. Post-tool hooks record runtime results and do not authorize execution retroactively.

## Lifecycle

The launcher consumes the Gateway event stream and stops its child on `session.kill-requested` (also accepting legacy `session.killed`). SIGTERM escalates to SIGKILL after three seconds. An unexpected stream failure also stops the managed child.

Only an observed child exit is reported to `/v1/sessions/:id/end` with exit code/signal. Spawn errors without an exit report do not establish process termination. Existing interactive Claude sessions cannot accept unsolicited dispatched tasks; see [task dispatch](../../docs/TASK_DISPATCH_API.md).
