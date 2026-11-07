import type { NormalizedEvent } from '../../contracts/src/index.js';
import type {
  AdapterCapabilities,
  AdapterCursor,
  AgentAdapter,
  NativeEventBatch,
  NativeRecord,
  NativeSession,
  SessionBinding,
} from './index.js';
import type { EventIngestClient } from './index.js';

/** Deterministic event source for adapter and gateway development. */
export class MockAgentAdapter implements AgentAdapter {
  readonly runtime: string;
  private connected = true;

  constructor(
    runtime: string,
    private readonly sessions: NativeSession[],
    private readonly recordsBySession: ReadonlyMap<string, NativeRecord[]>,
    private readonly supported: AdapterCapabilities = {
      passiveObservation: true,
      managedSession: false,
      contextInjection: false,
      preExecutionInterception: false,
    },
  ) {
    this.runtime = runtime;
  }

  capabilities(): AdapterCapabilities {
    return this.supported;
  }

  async discoverSessions(): Promise<NativeSession[]> {
    this.assertConnected();
    return this.sessions.map(session => ({ ...session }));
  }

  async readEvents(session: NativeSession, cursor?: AdapterCursor): Promise<NativeEventBatch> {
    this.assertConnected();
    if (session.runtime !== this.runtime || !this.sessions.some(candidate => candidate.nativeId === session.nativeId)) {
      throw new Error('Native session does not belong to this adapter');
    }
    const source = this.recordsBySession.get(session.nativeId) ?? [];
    const offset = cursor ? Number(cursor.value) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > source.length) {
      throw new Error(`Invalid mock cursor for ${session.nativeId}`);
    }
    const limit = Math.min(offset + 2, source.length);
    return {
      records: source.slice(offset, limit),
      nextCursor: { value: String(limit) },
      hasMore: limit < source.length,
    };
  }

  normalize(record: NativeRecord, binding: SessionBinding): NormalizedEvent {
    if (binding.runtime !== this.runtime) throw new Error('Session runtime does not match adapter');
    return {
      id: `${binding.runtime}:${binding.nativeId}:${record.nativeId}`,
      workspaceId: binding.workspaceId,
      source: `${binding.runtime}:${binding.nativeId}`,
      nativeId: record.nativeId,
      sessionId: binding.sessionId,
      type: record.type,
      mode: 'observed',
      payload: record.payload,
      occurredAt: record.occurredAt,
    };
  }

  disconnect(): void { this.connected = false; }
  reconnect(): void { this.connected = true; }
  async close(): Promise<void> { this.connected = false; }

  private assertConnected(): void {
    if (!this.connected) throw new Error(`${this.runtime} mock source is disconnected`);
  }
}

/** Small in-memory cursor implementation for local development and examples. */
export class MemoryCursorStore {
  private readonly cursors = new Map<string, AdapterCursor>();
  async get(key: string): Promise<AdapterCursor | undefined> {
    const cursor = this.cursors.get(key);
    return cursor ? { ...cursor } : undefined;
  }
  async set(key: string, cursor: AdapterCursor): Promise<void> {
    this.cursors.set(key, { ...cursor });
  }
}

/** In-memory stand-in for the unfinished Gateway ingestion endpoint. */
export class MockGatewayClient implements EventIngestClient {
  private readonly eventsBySourceIdentity = new Map<string, NormalizedEvent>();
  private available = true;

  async ingest(event: NormalizedEvent): Promise<boolean> {
    if (!this.available) throw new Error('Mock Gateway is unavailable');
    if (event.mode !== 'observed') throw new Error('Mock Gateway accepts observed events only');
    const key = `${event.workspaceId}\u0000${event.source}\u0000${event.nativeId}`;
    if (this.eventsBySourceIdentity.has(key)) return false;
    this.eventsBySourceIdentity.set(key, structuredClone(event));
    return true;
  }

  events(): NormalizedEvent[] {
    return [...this.eventsBySourceIdentity.values()].map(event => structuredClone(event));
  }

  disconnect(): void { this.available = false; }
  reconnect(): void { this.available = true; }
}

export const mockCapabilities: AdapterCapabilities = {
  passiveObservation: true,
  managedSession: false,
  contextInjection: false,
  preExecutionInterception: false,
};
