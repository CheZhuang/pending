import type { NormalizedEvent } from '../../contracts/src/index.js';

export type AdapterCapability =
  | 'passiveObservation'
  | 'managedSession'
  | 'contextInjection'
  | 'preExecutionInterception';

/** Capabilities describe what this adapter can actually do for a session. */
export type AdapterCapabilities = Readonly<Record<AdapterCapability, boolean>>;

export interface NativeSession {
  runtime: string;
  nativeId: string;
  cwd?: string;
  sourceRef?: string;
}

export interface SessionBinding extends NativeSession {
  /** PendingTree identity supplied by the trusted daemon, never by the model. */
  sessionId: string;
  workspaceId: string;
  branchId: string;
}

export interface AdapterCursor {
  /** Opaque, adapter-owned position that can be persisted and restored. */
  value: string;
}

export interface NativeRecord {
  /** Stable identifier within the native session, if the runtime supplies one. */
  nativeId: string;
  type: string;
  occurredAt: string;
  payload: unknown;
}

export interface NativeEventBatch {
  records: NativeRecord[];
  nextCursor: AdapterCursor;
  /** True if unread data remains after this batch. */
  hasMore: boolean;
}

export interface AgentAdapter {
  readonly runtime: string;
  capabilities(session: NativeSession): AdapterCapabilities;
  discoverSessions(): Promise<NativeSession[]>;
  readEvents(session: NativeSession, cursor?: AdapterCursor): Promise<NativeEventBatch>;
  normalize(record: NativeRecord, binding: SessionBinding): NormalizedEvent;
  /** Optional acknowledgement after its cursor is durably saved. */
  acknowledge?(cursor: AdapterCursor): Promise<void> | void;
  close(): Promise<void>;
}

/** Adapter-owned cursor persistence boundary; production storage is coordinated with A. */
export interface CursorStore {
  get(key: string): Promise<AdapterCursor | undefined>;
  set(key: string, cursor: AdapterCursor): Promise<void>;
}

/** Minimal ingestion seam so adapters can use a mock before daemon transport exists. */
export interface EventIngestClient {
  ingest(event: NormalizedEvent): Promise<boolean> | boolean;
}

/** Mirrors the core's administrative session-registration method. */
export interface SessionRegistrar {
  registerSession(
    branchId: string,
    agent: { id: string; name: string },
    runtime: string,
    nativeId: string,
  ): Promise<{ id: string; workspaceId: string; branchId: string; nativeId: string; runtime: string }> |
    { id: string; workspaceId: string; branchId: string; nativeId: string; runtime: string };
}

/** Register a native session through the trusted service and bind its returned identity. */
export async function registerNativeSession(
  registrar: SessionRegistrar,
  agent: { id: string; name: string },
  branchId: string,
  native: NativeSession,
): Promise<SessionBinding> {
  const registered = await registrar.registerSession(branchId, agent, native.runtime, native.nativeId);
  if (registered.branchId !== branchId || registered.nativeId !== native.nativeId || registered.runtime !== native.runtime) {
    throw new Error('Session registrar returned a mismatched native session binding');
  }
  return {
    ...native,
    sessionId: registered.id,
    workspaceId: registered.workspaceId,
    branchId: registered.branchId,
    runtime: registered.runtime,
    nativeId: registered.nativeId,
  };
}

export async function registerAdapterSession(
  adapter: AgentAdapter,
  registrar: SessionRegistrar,
  agent: { id: string; name: string },
  branchId: string,
): Promise<SessionBinding> {
  const sessions = await adapter.discoverSessions();
  if (sessions.length !== 1) throw new Error(`Expected one managed native session, received ${sessions.length}`);
  return registerNativeSession(registrar, agent, branchId, sessions[0]!);
}

export function cursorKey(binding: SessionBinding): string {
  return `${binding.runtime}:${binding.nativeId}:${binding.sessionId}`;
}

/**
 * Read one batch and checkpoint only after every event has been accepted by the
 * ingestion service. A failed ingest leaves the old cursor available for retry.
 */
export async function ingestNextBatch(
  adapter: AgentAdapter,
  binding: SessionBinding,
  cursorStore: CursorStore,
  client: EventIngestClient,
): Promise<NativeEventBatch> {
  const key = cursorKey(binding);
  const cursor = await cursorStore.get(key);
  const batch = await adapter.readEvents(binding, cursor);
  for (const record of batch.records) {
    await client.ingest(adapter.normalize(record, binding));
  }
  await cursorStore.set(key, batch.nextCursor);
  await adapter.acknowledge?.(batch.nextCursor);
  return batch;
}

export { MockAgentAdapter, MockGatewayClient, MemoryCursorStore, mockCapabilities } from './mock.js';
export { SqliteCursorStore, type GenericEntityStore } from './sqlite-cursor-store.js';
export { CodexAppServerAdapter, type CodexAppServerOptions } from './codex-app-server.js';
export { handleClaudePreToolHook, createClaudeDecideClient, type ClaudeDecideRequest, type ClaudeHookEnvironment } from './claude-pre-tool-hook.js';
export { createClaudeHookSettings, type ClaudeSettings } from './claude-settings.js';
export { HttpManagedClaudeGateway, runManagedClaude, type ClaudeLaunchOptions, type ManagedClaudeGateway, type ManagedClaudeEvent, type ManagedClaudeSession } from './claude-launcher.js';
export { NativeGatewayClient, type NativeConnection } from './gateway-client.js';
export { ManagedCodex, gatewayCodexApproval, type ManagedCodexOptions } from './codex-managed.js';
export { observeClaudeHook } from './claude-observer.js';
export { ProcessDiscovery, identifyProcess, sameProcess, type ProcessProvider, type ProcessSnapshot, type ManagedProcessBinding } from './process-discovery.js';
export { LocalProcessProvider, nativeStartTime } from './process-platform.js';
