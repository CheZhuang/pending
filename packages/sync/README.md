# @agentree/sync

Retrieves supervision records for one authenticated native session. This package
does not infer semantic compatibility, rank text, or grant authority.

## Rooted activity extraction

`toRootedPath(nativePath, roots, cwd?)` and `extractTouches(event, roots)` map
native activity onto known workspace files. They support Claude tool inputs,
normalized touch arrays, and Codex file change notifications. Only paths that
can be attributed to a known root are returned; no filesystem access occurs.
Core uses these records as activity and deterministic file-overlap evidence.

## Pull retrieval

```ts
const sync = new ContextSync(agentService, new EntityLedger(store));
const delta = sync.sync({ session, requestId });
sync.acknowledge(session.id, delta.items.map(item => item.itemId));
```

Every pull reads the current authorized supervision view from Core. The result
contains one complete Main snapshot for its revision, sibling branch work,
conflicts, and corrections addressed to the session's branch. A newer Main
snapshot replaces the agent's prior Main view, including removed entries.
Branch proposals remain proposals; no word or keyword comparison treats them
as semantically conflicting. File overlap is a potential signal for human
inspection, and only a human disposition confirms it.

Delivery is bounded by a configurable item count (default 100, maximum 500) and
tracked per session. Reuse `requestId` to replay the most recent response after a
lost reply; only the latest pull response is cached. Acknowledge item IDs after
the agent has read them. On resume,
`redeliverUnacknowledged` returns delivered but unacknowledged items. Retrieval
and acknowledgment do not prove that an agent followed Main or a correction.
The item limit does not cap bytes: Main is always delivered as one complete
snapshot, which can grow with the workspace's Main history.

The SQLite ledger uses the `supervision_ledger` entity kind. Historical
`sync_ledger` rows are left untouched and are never interpreted as new-protocol
delivery records.

Tests: `npm test` (from repository root).
