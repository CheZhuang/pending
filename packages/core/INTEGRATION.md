# Core integration

Use `ApplicationService` from `src/index.ts` and the supervision contracts from `packages/contracts`. The Gateway constructs an actor from authenticated credentials. MCP binds that same actor to the native session and revalidates credentials for every call.

Read `main`, `branchOverview`, `conflicts` or `supervision`. Agents use `proposeWork` with text, optional rooted files/native evidence and explicit incompatible Main entry references. Humans use `editMain`, `mainHistory`, `decideMerge`, `reportConflict`, `decideConflict` and `sendCorrection`. Preserve the Main revision when deciding or editing.

The former ContextCommit, knowledge kind/key/scope, MergeRequest and Review methods are intentionally removed. Historical entities remain in SQLite only for migration and audit. See [Gateway API](../../docs/GATEWAY_API.md).
