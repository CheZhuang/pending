# Local process discovery

The Gateway scans at startup and every five seconds. The Console's **Local coding agents** inventory is computer-wide and appears even when there is no workspace. Refresh processes requests a new OS scan. Exited processes disappear at the next successful scan. Failed enumeration clears the current inventory and reports `unavailable`; it never leaves old rows labeled as running.

Enumeration has a fifteen-second inventory deadline so a stuck OS query cannot hold an API refresh or shutdown indefinitely. The local provider shares an in-flight OS query across refreshes rather than starting another query every polling tick.

## Platform support

| Platform | Enumeration | Stable process identity | Working directory | Independent native observation |
| --- | --- | --- | --- | --- |
| Linux | Maintained `systeminformation` library, enriched with `/proc` executable and NUL-delimited argv | Boot ID + `/proc/PID/stat` birth ticks + PID | `/proc/PID/cwd`, when readable | Process metadata only |
| macOS | `systeminformation` process listing | `proc_pidinfo(PROC_PIDTBSDINFO)` birth seconds/microseconds + PID via Koffi | Currently unavailable | Process metadata only |
| Windows | `systeminformation` (CIM `Win32_Process` through PowerShell) | `GetProcessTimes` creation FILETIME + PID via Koffi | Currently unavailable | Process metadata only |

The application delegates OS listing to a maintained library instead of maintaining its own shell scripts. Start identity uses precise OS birth information, not the library's elapsed-time estimate. Windows requests only `PROCESS_QUERY_LIMITED_INFORMATION` and closes every process handle. macOS uses libproc without attaching a debugger. Koffi is loaded lazily on macOS/Windows; Linux needs no FFI.

`startTime` is an opaque birth token, not an ISO timestamp. Missing permissions or unavailable native bindings leave it absent and set `identityReliable:false`. Such sightings remain visible but cannot be linked to managed sessions; their row identities change between scans so PID reuse cannot imply continuity. OS visibility is limited by the daemon account, sandbox/container PID namespace and OS permissions. No elevation is requested by discovery.

## Identification and duplicate handling

Identification recognizes native `claude`/`codex` executable names, Codex platform binary names, the Claude versioned installation layout with a Claude argv identity, and official `@anthropic-ai/claude-code/cli.js` / `@openai/codex/bin/codex.js` Node entrypoints. It does not classify arbitrary Node, terminal, shell, prompt text or product names inside arguments. A direct native child of an identified official Node wrapper is represented by the wrapper to avoid the npm wrapper/binary duplicate. Other parent/child agents remain independent.

Names and paths are identification evidence, **not authenticated product provenance**. A renamed executable or matching local directory can imitate them. Unusual wrappers, Node flags before the script, custom renames, truncated command displays and restricted process details can cause missed agents. On macOS/Windows command arguments come from OS-rendered command lines and may be less exact than Linux's argv. `commandLine` is a display reconstruction; use `argv` for metadata, never execute it. Empty Linux argv arguments are retained.

## Observation and control

Discovery creates no Session, workspace, branch, bearer credential, hook, App Server or durable snapshot. It never signals a discovered PID, writes native settings, resumes native threads, reads process environments or opens a native control channel.

All discovery capability flags are false: they describe capabilities acquired **by discovery**. An independent agent remains visible with `nativeObservation:"unavailable"`. Existing Claude hooks and Codex App Server journals observe managed sessions through their existing authenticated adapters. When `managedSessionId` is present, consult that existing Session for lifecycle, activity, approvals and task dispatch. A metadata association does not upgrade or change those capabilities.

PendingTree currently has no reader for arbitrary Claude transcripts or Codex CLI rollout histories. A shared cwd, parent process, recent file, or similar timestamp is insufficient to associate a history with one running process, especially with multiple agents in one project. No native history is auto-imported on those hints. An independent CLI cannot accept PendingTree tasks, instruction injection or tool interception through this API. Use the managed launchers for those existing capabilities.

Launchers best-effort report their child PID and precise birth identity with their own session credential. The Gateway verifies a fresh discovered identity and matching runtime, rejects another session's existing claim, and records only an in-memory association. Failed association does not stop a managed runtime. Gateway restart discards these ephemeral claims; existing session credentials and observation records retain their original durability. Legacy launchers do not report process identity and therefore cannot be correlated automatically.

## Gateway and Console contract

Shared types live in `packages/contracts/src/gateway.ts`; process providers and inventory logic live in `packages/adapters/src/process-{platform,discovery}.ts`.

| Endpoint | Access | Result |
| --- | --- | --- |
| `GET /v1/processes` | Local human | `{status,scannedAt?,message?,processes}`; waits for startup scan |
| `POST /v1/processes/refresh` | Local human | Same inventory after a scan; overlapping refresh requests share the scan |
| `POST /v1/sessions/:id/process` | That active Session's bearer | `{pid,startTime}` claim; returns `{ok:true}` after identity/runtime checks |

Each process has `id`, `runtime`, `pid`, optional `startTime`, `parentPid`, `executable`, `argv`, `commandLine`, `cwd`, plus `evidence`, `identityReliable`, optional `managedSessionId`, `capabilities` and `nativeObservation`. Sessions can include the last launcher-reported `process` identity; that field alone does not assert continued liveness. The process inventory is the current OS view. Ending a managed Session removes its association without removing a still-running OS process.

The Console consumes these routes through the live API module, with matching mock methods. It polls every five seconds, renders text through Vue/Naive UI, and offers refresh without unmanaged Stop/Task controls. Its inventory does not depend on workspace selection. The existing local-human/loopback/Host/Origin boundary applies to both discovery routes; session bearers cannot enumerate other processes. Command lines may contain private arguments, so the inventory is admin-only, never added to the event stream or logged/persisted by discovery. See [local security](LOCAL_SECURITY.md).

## Verification

Linux: the test suite runs identification fixtures for all three platforms and a real spawned official-entrypoint-shaped Node fixture, checking birth identity, argv, cwd and exit disappearance. Gateway HTTP tests cover startup waiting, explicit refresh, credential boundaries and managed correlation. Unit fixtures cover PID reuse, missing data, duplicate avoidance, concurrent refresh, scan failures and unsupported capabilities.

macOS and Windows: platform fixtures have run on Linux; native OS execution has **not** been performed in this implementation environment. The CI discovery matrix targets Ubuntu, macOS and Windows, with gated native creation-time smoke checks. Those CI results must be checked before claiming native validation on those systems.

OS API references: [Apple proc_info definitions](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info.h), [Microsoft GetProcessTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes), [Koffi output buffers](https://koffi.dev/output), and [systeminformation process listing](https://systeminformation.io/processes.html).
