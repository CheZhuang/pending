# Agentree MCP

The trusted host binds one native session to Core and a delivery ledger:

```ts
const service = new AgentreeService(store, { type: 'agent', sessionId: session.id });
const server = await serveAgentreeMcp({
  session, service, ledger: new EntityLedger(store), authorize,
});
```

`store`, `session`, and `authorize` are trusted host dependencies. Import the service from Core, `EntityLedger` from Sync, and `serveAgentreeMcp` from this package. The native entry point supplies `authorize` to revalidate the session credential before every tool call, including cached retries. Embedded hosts must supply equivalent authentication; the callback is optional in the library API.

## Tools

| Tool | Input / behavior |
| --- | --- |
| `workspace_status` | No arguments; bound workspace, branches, and session |
| `context_get` | No arguments; full authorized supervision view |
| `context_sync` | Required `requestId`; optional `limit` (1–500, default 100) and `redeliverUnacknowledged` |
| `context_acknowledge` | `itemIds` array; marks delivered items acknowledged for this session |
| `work_propose` | Required `body`; optional `files`, `intent`, `eventIds`, and `conflictsWithMain` |

File references use `{rootId,path}`. Proposals always target the bound session branch. Results use `{ok,data}` or `{ok:false,error:{code,message}}`; failures also set MCP `isError`.

Main writes and human governance are outside this tool surface. See [Sync](../sync/README.md) for snapshot replacement, retries, limits, and ledger semantics; [native setup](../../docs/NATIVE_AGENTS.md) covers configuration. MCP is a pull channel and does not prove an agent followed the retrieved guidance.
