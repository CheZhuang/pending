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
  /** Agentree identity supplied by the trusted daemon, never by the model. */
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
  return batch;
}
