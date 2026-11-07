# @agentree/sync (Task C)

Decides which context is relevant to which session. Pure functions only: no
SQLite access, no filesystem access, no permission decisions.

- `toRootedPath(nativePath, roots, cwd?)` maps native paths onto `{ rootId, path }`
  (longest matching root; outside-workspace and ambiguous paths are dropped).
- `extractTouches(event, roots)` reads file activity from observed events.
  Adapters should prefer `payload.touches: [{ path, rootId?, access: 'read' | 'write' }]`;
  Claude Code `tool_name`/`tool_input.file_path` and Codex `changes[].path` are also understood.
- `deriveFocus({ sessionId, events, roots, declaration? })` builds a weighted focus:
  declared scopes (1.0) > modified files (0.9) > read files (0.6) > folders of
  modified files (0.4) > touched roots (0.2). Older files decay to half weight.
  `declaration.mode: 'override'` ignores inferred activity.
- `relevance(knowledge, focus)` returns the best match over the location
  `scope` and the `impactScope` (`via: 'location' | 'impact'`), or `undefined`
  when unrelated. Matching is segment-aware, root-aware, and tasks only match
  the same task id.

Relevance is not access: a high score never grants a read or write, and a
relevant Finding is still only a Finding.

Tests: `npx -y node@24 --import tsx --test packages/sync/src/*.test.ts`

## Incremental delivery (`ContextSync`)

```ts
const sync = new ContextSync(agentService, new EntityLedger(store)); // agent-bound ApplicationService
const delta = sync.sync({ session, level: 'digest', budgetTokens: 2000, requestId }); // pull (MVP default)
sync.acknowledge(session.id, delta.items.map(i => i.itemId));        // explicit, never automatic
sync.subscribe(session.id, { mode: 'extend', scopes: [{ type: 'folder', path: 'docs' }] });
```

- **Reads only through `ApplicationService`** (`workspace`, `branches`, `contextRevision`,
  `snapshot`, `events`), so every read is authorized as the agent's own session.
- **Candidates**: main entries are `accepted-finding` / `accepted-decision` (main only takes
  human-reviewed merges), other branches' local drafts are `finding` / `proposed-decision`.
  A previously delivered main decision that is no longer in force is sent once as
  `superseded-decision`. Own drafts are never echoed back; own work becoming accepted is.
- **Relevance**: location or impact scope must match the session focus. Exception
  (`match: 'follow-up'`): proposals and replacements for a decision key this session was
  already told about.
- **Delivery states** per session and item (`commitId:authority`): `pending → delivered →
  acknowledged`. An authority upgrade (finding → accepted) is a new item, so it is delivered
  again; the same item is never delivered twice under normal operation.
- **Idle polls are free**: a fingerprint of all branch revision tokens + focus scopes is
  stored; if unchanged and nothing is pending, no snapshot is loaded.
- **Levels**: `signal` (key, scope, authority), `digest` (+ body ≤ 280 chars, provenance),
  `full` (+ full body, event ids, timestamps). Items are packed by priority
  (relevance × authority weight); an item that doesn't fit is downgraded, otherwise
  deferred (stays pending) to the next sync.
- **Retry safety**: pull with the same `requestId` replays the stored response. Push mode
  (`prepare` → adapter delivers → `commit(batchId)`, or `push(request, sink)`) only marks
  items delivered after the adapter confirms.
- **Resumed sessions**: the ledger is persisted in SQLite; `redeliverUnacknowledged: true`
  re-sends delivered-but-unacknowledged items when a native session lost its context.

Every package carries a `notice` saying the items are data with provenance, and that only
`accepted-*` items were human-reviewed.
