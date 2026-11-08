# Sync

`ContextSync` retrieves authorized supervision context for a bound session. It does not rank knowledge, infer semantic compatibility, or grant authority.

```ts
const sync = new ContextSync(agentService, new EntityLedger(store));
const delta = sync.sync({ session, requestId });
sync.acknowledge(session.id, delta.items.map(item => item.itemId));
```

`agentService`, `store`, `session`, and `requestId` come from the trusted host. Public exports are in [src/index.ts](src/index.ts).

## Retrieval and ledger

Each new pull reads Core's current view. Items contain the full Main snapshot for its revision, sibling branch work, conflicts, and corrections addressed to the session branch. A newer Main snapshot replaces the previous reference, including removal history. Proposed branch work remains unapproved.

Delivery is tracked per session by `MemoryLedger` or durable `EntityLedger`. Reusing the most recent `requestId` replays its cached response after a lost reply; only the latest response is cached. Acknowledge delivered item IDs after reading them. `redeliverUnacknowledged` includes previously delivered items still awaiting acknowledgment.

The default item limit is 100, maximum 500. Main is one complete item, so this is not a byte/token limit. Retrieval and acknowledgment do not demonstrate compliance. The durable ledger uses `supervision_ledger`; see [migration](../../docs/MIGRATION.md) for legacy isolation.

## Rooted activity

`toRootedPath(nativePath, roots, cwd?)` and `extractTouches(event, roots)` normalize Claude inputs, normalized touches, and Codex file-change evidence against known roots without filesystem access. Core uses write touches for potential overlap signals. See [architecture](../../docs/ARCHITECTURE.md#evidence-and-control) for path identity and evidence rules.
