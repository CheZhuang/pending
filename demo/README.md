# Deterministic two-agent supervision demo

Run `npm run demo`. The demo uses a temporary SQLite database and deterministic
mock Claude/Codex activity; it does not contact a live model or modify the
project.

It exercises the whole supervision loop:

1. Create a workspace, logical branches and two session bindings.
2. Replay rooted Claude and Codex file observations through the adapter layer.
3. Add human-governed Main guidance and retrieve the current Main snapshot with
   both MCP clients.
4. Submit branch work with affected files and an explicit incompatible Main
   entry reference.
5. Inspect the generated potential conflict, record a human disposition, and
   send a correction to one branch.
6. Accept one work record into Main and retrieve the replacement Main snapshot.
7. Confirm an agent's attempted Main edit is denied and audited.

Observed file overlap is evidence for inspection, not a semantic conflict
claim. Branch work remains proposed until a human accepts it. Retrieval and
acknowledgment do not prove that an agent followed Main or a correction. There
is no native push to an active runtime; the agent reads through MCP.
