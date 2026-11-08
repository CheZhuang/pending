# Agentree MCP integration

The trusted host binds one authenticated native session to an `AgentreeService`
and durable `EntityLedger`:

```ts
const service = new AgentreeService(store, { type: 'agent', sessionId: session.id });
const server = await serveAgentreeMcp({ session, service, ledger: new EntityLedger(store) });
```

The caller cannot choose its identity or branch. The native host revalidates its
credential before every tool call, including cached retries.

## Agent tools

- `workspace_status`: report the bound workspace, branches and session.
- `context_get`: retrieve the current full supervision view.
- `context_sync`: retrieve the current Main snapshot, sibling branch work,
  conflicts, and corrections addressed to the bound branch. A newer Main
  snapshot replaces the previous one; its removed-entry history records
  removals. Branch work remains proposed evidence unless a human accepts it.
- `context_acknowledge`: record that item IDs were retrieved and acknowledged.
- `work_propose`: add work to the session's own branch with optional rooted
  files, intent, observed event IDs and explicit incompatible Main entry IDs.

Main changes are human-only. There is no semantic keyword conflict detector:
rooted file overlap is only a potential conflict, and a human makes the
disposition. Corrections are durable human messages for one branch. Retrieval
and acknowledgment do not prove an agent complied, and MCP has no unsolicited
push into an arbitrary active native session.

`context_sync` takes a request ID for retry safety and an optional item-count
limit (default 100, maximum 500). The delivery ledger is durable across
reconnections. Large Main snapshots are sent as one complete item, so the item
limit does not cap snapshot bytes. The new ledger uses the `supervision_ledger`
entity kind; legacy context-sync rows remain archival.

## Host boundary

The session, Core service and ledger are trusted host dependencies. Never accept
an actor, workspace, or branch identity from tool arguments. Native Gateway
transport, credential lifecycle and execution approvals remain separate from
context retrieval. A successful tool approval records a decision, not proof
that the native runtime executed the action.
