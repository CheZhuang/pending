# Storage

`SqliteStore` in [src/index.ts](src/index.ts) provides SQLite entity persistence, transactions, durable event identities/sequences, deduplication, and cursor queries. It uses Node's built-in `node:sqlite`, requiring Node.js 24+ for this repository.

Opening the store applies schema migrations automatically. See [migration](../../docs/MIGRATION.md) for backups, version 3 projection, retained legacy evidence, and compatibility. Domain authorization belongs to Core; Gateway credentials and task delivery have their own tables in the same database.

The default database location and overrides are documented in the [project README](../../README.md#local-configuration). Migration and restart tests run through the root `npm test` command.
