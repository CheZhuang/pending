# Core integration

Construct `AgentreeService` from [src/index.ts](src/index.ts) with an entity store and a trusted actor. `ApplicationService` is a TypeScript interface type, not a constructor. Use records and validation from [Contracts](../contracts/README.md).

```ts
import { AgentreeService } from './src/index.js';

const service = new AgentreeService(store, { type: 'human', id: 'local-admin' });
const snapshot = service.main(workspaceId);
service.editMain(workspaceId, { body: 'Preserve public API compatibility.' }, snapshot.revision);
```

Here `store` and `workspaceId` are host-provided dependencies. The Gateway derives actors from credentials. The native MCP host binds a session actor and revalidates the credential before every call; never deserialize an actor from agent input.

| Operation | Service methods |
| --- | --- |
| Read context | `main`, `branchOverview`, `conflicts`, `supervision` |
| Main history | `mainHistory`, `mainAtRevision` |
| Human Main writes | `editMain`, `removeMain`, `restoreMain` |
| Agent proposals | `proposeWork` |
| Human assessment | `decideMerge`, `reportConflict`, `decideConflict`, `sendCorrection` |

Pass the expected global Main revision for edits, removals, restoration, and merge decisions. See [Main API](../../docs/MAIN_API.md) for stale writes and restoration, and [migration](../../docs/MIGRATION.md) for retired service models.
