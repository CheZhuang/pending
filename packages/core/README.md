# Core

`AgentreeService` owns human-governed Main, logical branches, lightweight work proposals, evidence-backed potential conflicts, human acceptance/rejection and corrections. It preserves native sessions, workspace access, event ingestion and policy audit records.

Construct the actor only at a trusted boundary. Agent arguments never provide an actor. An agent can propose on its authenticated session branch and read its workspace; Main writes, acceptance, conflict dispositions and correction messages require a human. Every Main mutation uses the expected global revision and retains entry history.

`decideMerge` accepts or rejects work records. It does not touch Git or project files. See [architecture](../../docs/ARCHITECTURE.md) for exact behavior, ownership and migration.
