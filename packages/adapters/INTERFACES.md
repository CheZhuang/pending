# B package interface notes

Adapters and MCP reuse `packages/contracts` domain types and A's `ApplicationService`. Identity is constructed at the trusted daemon boundary; native/model payloads never choose an Actor. Observed events grant no execution authority.

## Implemented integration

- Administrative native-session registration helpers validate the returned branch/runtime/native ID binding.
- `SqliteCursorStore` persists adapter checkpoints through the generic entity API. Event deduplication uses `(workspaceId, source, nativeId)`.
- Codex keeps uncheckpointed observations in a local delivery journal. Normalized file-change events expose `item.changes` and `cwd` for C's `extractTouches`, while retaining the original notification params.
- MCP now uses C's `ContextSync` with an injected durable `EntityLedger`. Pull/retry, subscriptions, acknowledgement, budgets and authority upgrades share C's implementation.
- MCP publications support `impactScope` and expected branch/main snapshot tokens. Merge requests can include the expected inherited-main revision.

## Remaining host integration

The HTTP entry point is still a health stub. Gateway transport authentication, trusted launch registration (including native ID allocation), specific tool policy/approval decisions, and end/kill lifecycle APIs remain A/B integration requirements. See `packages/mcp/README.md` for the concrete handoff. CLI entry points, Claude transcript observation and native-runtime end-to-end validation remain separate work.
