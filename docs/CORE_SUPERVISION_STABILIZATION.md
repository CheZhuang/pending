# Supervision correctness and processing boundaries

Conflict read models now assess pending integration evidence. All original native events, proposals, acceptance records, Main revisions, and human conflict decisions remain available in storage and the audit event stream.

## Relevant work

- A proposed work record remains relevant until a human accepts or rejects it, even after its native turn completes.
- Raw observed writes contribute only after the latest observed `turn/completed` or Gateway `session.ended` event for that session. Completion ends a transient observation window; it does not prove correctness or incorporation into Main. Controlled approval events never prove a write.
- Each new proposal captures an event-sequence watermark. Acceptance or rejection closes that session's raw observation window through the proposal watermark. Later observations and other sessions remain eligible. Other pending proposals remain eligible independently.
- Existing proposals without watermarks use their immutable `work.proposed` audit sequence. If neither exists (for example imported legacy records), no settlement cutoff is guessed. Explicit completion or subsequent human settlement can bound later evidence.
- These boundaries use persisted arrival sequence, never wall-clock timestamp ordering. Adapters may omit completion notifications or deliver events late. The Core cannot reliably attribute every file write to an individual proposal or overlapping native turn. This intentionally small session window assumes sequential native work; late writes remain new evidence. Agents should publish explicit proposals for completed work awaiting integration. A proposal's watermark covers prior session observations, not an inferred per-file ownership claim.

## Conflict assessment and acceptance

Overlap remains potential evidence, not a finding of incompatibility. Generated IDs include the sorted evidence identity set and any referenced Main entry revision. Re-reading unchanged evidence retains its human disposition. A new proposal, write, or Main revision receives a new assessment, even for a previously dismissed file.

A persisted generated decision appears in current conflicts only while its evidence is current. Older decisions stay in entities and immutable `conflict.decided` audit events. Manual human reports remain current until explicitly resolved or dismissed. Existing generated IDs are reassessed once under the new evidence-based identity rule; their historical decisions are preserved.

Pending work read models include `acceptanceWarnings` with `unresolvedConflictIds` and `overlappingMainEntryIds`. Conflicts match selected work by proposal ID, explicit event evidence, or file identity. Reports without file evidence apply to their branch; proposals without file declarations conservatively receive branch conflict warnings because attribution is unknown.

`decideMerge(..., overrideConflicts = false)` rejects acceptance with unresolved potential or confirmed conflicts using `CONFLICT` and warning details. The HTTP response is 409. An authorized human may explicitly pass `overrideConflicts: true`; the CLI offers `--override-conflicts`, and the Console asks for confirmation after displaying warnings. The immutable acceptance record and audit include the warning IDs and override. Resolving/dismissing conflicts also allows ordinary acceptance. Rejection needs no override.

Acceptance appends conclusions to Main; existing Main entries are retained, so the Console warns of overlapping expectations. It never merges Git or edits source files. Existing optimistic revision checks, one Main revision per accepted record, and atomic rollback of the entire selected batch are preserved. No revisions are consumed by rejection or a refused/failed acceptance.

## Backend processing

Task queries use indexes for session history, status/oldest queued task, session/native-turn identity, restart recovery, and native event replay. Replay selects only the acknowledged turn in the same workspace/session, preserving observations that arrive before acknowledgment. Request immutability, retry identity, cancellation and uncertain restart outcomes remain unchanged. Queue delivery does not load unrelated task history or settled work. Explicit history reads retain the existing response shape and ordering.

Git evidence uses asynchronous subprocesses and filesystem reads, with at most four concurrent Git processes globally, at most twelve distinct files per HTTP evidence response, a 650 ms command budget including queue time, a two-second per-file Git budget, 256 KiB subprocess output limits, 16,000 characters of returned diff, and an 8 MiB file hashing limit. Expired queued commands do not spawn. Timeout kills the child; failures return best-effort unavailable evidence. Other requests and event-loop delivery can proceed while evidence is collected.

Evidence validates workspace-relative paths and real filesystem containment, rejects Windows drive/UNC/backslash input independently of host OS, and rejects symlinks escaping the declared root. Git pathspecs are literal; external diff and textconv are disabled, as are optional index writes and filesystem-monitor hooks. Untracked diffs use Node's platform-specific null device and accept Git's expected exit status 1. Checkout evidence remains a snapshot of the shared filesystem and is never attributed to a logical branch. Filesystem containment is best-effort against concurrent trusted local checkout changes; it is not an OS filesystem sandbox.

## Validation

`npm test` passed with 102 tests passing and one platform-specific process-birth-identity test skipped on Linux (103 total). Coverage includes 10,000 unrelated task records and SQLite query plans, native acknowledgment races, completion/settlement boundaries, new assessments after dismissal, explicit human override through HTTP and CLI, rollback during batch acceptance, actual temporary Git repositories, an actual slow subprocess, event-loop responsiveness, path containment, platform null-device selection, and unavailable Git history. `npm --prefix apps/web test`, `npm run typecheck`, and `npm run build` passed. The backend suite required execution outside this environment's sandbox after its Node runtime aborted internally during async I/O. Windows-specific input rejection and portable argument selection are tested here; a native Windows execution was not available.

## Windows local capability follow-up

The cross-platform discovery job exposed a startup failure in existing local authentication: Windows reports synthetic Unix mode bits, so a successfully created token failed the POSIX owner-only check. Windows now uses its security descriptor instead. Windows PowerShell 5.1 invokes the .NET Framework FileStream constructor with a protected ACL granting FullControl only to the current user's SID at CreateNew time. There is no interval in which a newly created token inherits a broader ACL. Creation stays exclusive, and existing files are never overwritten or silently given different permissions.

Reads validate the file owner and protected ACL and read the credential using the same handle, with concurrent writes/deletion denied. Existing files with inherited or additional grants fail closed. Unix mode/UID validation remains in place on Linux/macOS; links, invalid contents, managed-session access, and non-loopback destinations remain rejected. PowerShell runs without profiles, with an absolute system executable, a five-second timeout, and bounded output. Paths travel in an environment variable and use literal path APIs; token creation passes the secret through stdin, never command-line arguments.

The discovery CI matrix now also runs local-auth regressions, including a Windows-only test that adds an Everyone read grant and verifies rejection. Quoted/wildcard path names, persistent tokens, actual symlink targets, and malformed contents are covered. Discovery teardown tolerates failed startup so it preserves the original error. Native Windows validation must run in CI; the available local host is Linux.
