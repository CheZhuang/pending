import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
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

type JsonObject = Record<string, unknown>;
interface RpcResponse { id: number; result?: unknown; error?: { code?: number; message?: string } }
interface RpcNotification { method: string; params?: unknown }
interface PendingRequest { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

export interface CodexAppServerOptions {
  cwd?: string;
  command?: string;
  args?: string[];
  /** The official clientInfo object sent during initialize. */
  clientInfo?: { name: string; title: string; version: string };
  /** Optional native thread/start parameters, such as model selection. */
  threadStartParams?: JsonObject;
  /** Last durable event cursor, used to continue stable event numbering on resume. */
  initialCursor?: AdapterCursor;
}

class StdioJsonRpc {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<(notification: RpcNotification) => void>();
  private readonly lines: ReturnType<typeof createInterface>;
  private closed = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', line => this.onLine(line));
    child.on('error', error => this.fail(error));
    child.on('exit', (code, signal) => this.fail(new Error(`codex app-server exited (${signal ?? code ?? 'unknown'})`)));
  }

  request<T>(method: string, params: JsonObject = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Codex app-server transport is closed'));
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex RPC ${method} timed out`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.write({ jsonrpc: '2.0', id, method, params });
    return promise;
  }

  notify(method: string, params: JsonObject = {}): void {
    if (this.closed) throw new Error('Codex app-server transport is closed');
    this.write({ jsonrpc: '2.0', method, params });
  }

  onNotification(listener: (notification: RpcNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    this.child.kill('SIGTERM');
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('Codex app-server transport closed'));
    }
    this.pending.clear();
  }

  private write(message: JsonObject): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`, error => {
      if (error) this.fail(error);
    });
  }

  private onLine(line: string): void {
    let message: JsonObject;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      message = parsed as JsonObject;
    } catch {
      // Ignore non-JSON stdout lines; only protocol messages become events.
      return;
    }
    if (typeof message.id === 'number') {
      const response = message as unknown as RpcResponse;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.error) pending.reject(new Error(`Codex RPC ${response.error.code ?? ''}: ${response.error.message ?? 'request failed'}`));
      else pending.resolve(response.result);
      return;
    }
    if (typeof message.method === 'string') {
      const notification = { method: message.method, params: message.params };
      for (const listener of this.listeners) listener(notification);
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.child.kill('SIGTERM');
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
  }
}

/**
 * Managed Codex adapter using the documented local app-server stdio protocol.
 * It controls only the thread it starts or explicitly resumes.
 */
export class CodexAppServerAdapter implements AgentAdapter {
  readonly runtime = 'codex-app-server';
  private sequence = 0;
  private readonly history: NativeRecord[] = [];
  private readonly capabilitiesValue: AdapterCapabilities = {
    passiveObservation: true,
    managedSession: true,
    contextInjection: false,
    preExecutionInterception: false,
  };

  private constructor(private rpc: StdioJsonRpc, readonly nativeId: string, private readonly options: CodexAppServerOptions) {
    rpc.onNotification(notification => this.capture(notification));
  }

  static async start(options: CodexAppServerOptions = {}): Promise<CodexAppServerAdapter> {
    const rpc = CodexAppServerAdapter.spawn(options);
    try {
      await CodexAppServerAdapter.initialize(rpc, options);
      const startupNotifications: RpcNotification[] = [];
      const unsubscribe = rpc.onNotification(notification => startupNotifications.push(notification));
      const result = await rpc.request<{ thread: { id: string } }>('thread/start', {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...options.threadStartParams,
      });
      if (!result?.thread?.id) throw new Error('Codex app-server thread/start returned no thread id');
      const adapter = new CodexAppServerAdapter(rpc, result.thread.id, options);
      unsubscribe();
      for (const notification of startupNotifications) adapter.capture(notification);
      return adapter;
    } catch (error) {
      await rpc.close();
      throw error;
    }
  }

  static async resume(nativeId: string, options: CodexAppServerOptions = {}): Promise<CodexAppServerAdapter> {
    const rpc = CodexAppServerAdapter.spawn(options);
    try {
      await CodexAppServerAdapter.initialize(rpc, options);
      const adapter = new CodexAppServerAdapter(rpc, nativeId, options);
      adapter.sequence = CodexAppServerAdapter.cursorSequence(options.initialCursor);
      await rpc.request('thread/resume', { threadId: nativeId });
      return adapter;
    } catch (error) {
      await rpc.close();
      throw error;
    }
  }

  capabilities(): AdapterCapabilities { return this.capabilitiesValue; }

  async discoverSessions(): Promise<NativeSession[]> {
    return [{ runtime: this.runtime, nativeId: this.nativeId, cwd: this.options.cwd, sourceRef: `codex-thread:${this.nativeId}` }];
  }

  async startTurn(prompt: string, params: JsonObject = {}): Promise<unknown> {
    return this.rpc.request('turn/start', { ...params, threadId: this.nativeId, input: [{ type: 'text', text: prompt }] });
  }

  async interruptTurn(turnId: string): Promise<unknown> {
    return this.rpc.request('turn/interrupt', { threadId: this.nativeId, turnId });
  }

  async readEvents(session: NativeSession, cursor?: AdapterCursor): Promise<NativeEventBatch> {
    this.assertSession(session);
    const offset = cursor ? Number(cursor.value) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.sequence) throw new Error('Invalid Codex event cursor');
    const records = this.history.filter(record => Number(record.nativeId.split(':').at(-1)) > offset);
    const page = records.slice(0, 100);
    const last = page.length ? Number(page.at(-1)!.nativeId.split(':').at(-1)) : offset;
    return { records: page, nextCursor: { value: String(last) }, hasMore: records.length > page.length };
  }

  acknowledge(cursor: AdapterCursor): void {
    const sequence = Number(cursor.value);
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > this.sequence) throw new Error('Invalid Codex event acknowledgement');
    let removeCount = 0;
    while (removeCount < this.history.length && this.sequenceFor(this.history[removeCount]!) <= sequence) removeCount += 1;
    this.history.splice(0, removeCount);
  }

  normalize(record: NativeRecord, binding: SessionBinding): NormalizedEvent {
    this.assertSession(binding);
    return {
      id: record.nativeId,
      workspaceId: binding.workspaceId,
      source: `${this.runtime}:${this.nativeId}`,
      nativeId: record.nativeId,
      sessionId: binding.sessionId,
      type: record.type,
      mode: 'observed',
      payload: record.payload,
      occurredAt: record.occurredAt,
    };
  }

  async reconnect(): Promise<void> {
    await this.rpc.close();
    const rpc = CodexAppServerAdapter.spawn(this.options);
    try {
      await CodexAppServerAdapter.initialize(rpc, this.options);
      // Keep sequence monotonic across process restart. Attach before resume so
      // notifications produced by resume are not missed.
      this.rpc = rpc;
      rpc.onNotification(notification => this.capture(notification));
      await rpc.request('thread/resume', { threadId: this.nativeId });
    } catch (error) {
      await rpc.close();
      throw error;
    }
  }

  async close(): Promise<void> { await this.rpc.close(); }

  private capture(notification: RpcNotification): void {
    this.sequence += 1;
    const params = notification.params;
    const row = params && typeof params === 'object' && !Array.isArray(params) ? params as JsonObject : { value: params };
    const timestamp = typeof row.timestamp === 'string' ? row.timestamp : new Date().toISOString();
    this.history.push({
      nativeId: `codex:${this.nativeId}:event:${this.sequence}`,
      type: notification.method,
      occurredAt: timestamp,
      payload: { method: notification.method, params },
    });
  }

  private sequenceFor(record: NativeRecord): number {
    return Number(record.nativeId.split(':').at(-1));
  }

  private assertSession(session: NativeSession): void {
    if (session.runtime !== this.runtime || session.nativeId !== this.nativeId) throw new Error('Session does not belong to this Codex adapter');
  }

  private static spawn(options: CodexAppServerOptions): StdioJsonRpc {
    const child = spawn(options.command ?? 'codex', options.args ?? ['app-server', '--listen', 'stdio://'], {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    // The protocol uses stdout only. Drain stderr to avoid child-process backpressure.
    child.stderr.resume();
    return new StdioJsonRpc(child);
  }

  private static async initialize(rpc: StdioJsonRpc, options: CodexAppServerOptions): Promise<void> {
    await rpc.request('initialize', {
      clientInfo: options.clientInfo ?? { name: 'agentree', title: 'Agentree', version: '0.1.0' },
    });
    rpc.notify('initialized');
  }

  private static cursorSequence(cursor?: AdapterCursor): number {
    const sequence = cursor ? Number(cursor.value) : 0;
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Invalid initial Codex event cursor');
    return sequence;
  }
}
