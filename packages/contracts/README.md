# Contracts

Shared TypeScript records and Zod schemas for workspaces, sessions, rooted files, Main, branch work, conflicts, corrections, merges, and events live in [src/index.ts](src/index.ts). Gateway wire contracts live in [src/gateway.ts](src/gateway.ts).

Contracts describe data and validate input. Authorization and domain mutations belong to [Core](../core/README.md); HTTP authentication and transport belong to the [Gateway](../../docs/GATEWAY_API.md). See [architecture](../../docs/ARCHITECTURE.md) for ownership.
