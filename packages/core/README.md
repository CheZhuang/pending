# Core

`AgentreeService` owns workspace access, Main revisions/history, branch work, conflict evidence, human merge decisions, corrections, session observations, and policy audit. `ApplicationService` is its public interface type.

Actors come from trusted host authentication. An agent reads its workspace and proposes on its own session branch; human authority is required for Main writes, acceptance, conflict decisions, and corrections.

See [integration](INTEGRATION.md) for service usage, [architecture](../../docs/ARCHITECTURE.md) for domain behavior, and [Main API](../../docs/MAIN_API.md) for revision semantics. Run checks from the repository root as described in [verification](../../docs/SUPERVISION_VERIFICATION.md).
