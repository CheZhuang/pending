import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createClaudeHookSettings } from './claude-settings.js';

export interface ManagedClaudeSession {
  sessionId: string;
  afterSeq: number;
}

export interface ManagedClaudeEvent {
  seq: number;
  type: string;
  sessionId?: string;
}

export interface ManagedClaudeGateway {
  registerSession(input: { runtime: 'claude-code'; cwd: string; label: string }): Promise<ManagedClaudeSession>;
  stream(afterSeq: number, signal: AbortSignal): AsyncIterable<ManagedClaudeEvent>;
  endSession(sessionId: string): Promise<void>;
}

/** REST bridge for the session/stream routes described by the shared gateway plan. */
export class HttpManagedClaudeGateway implements ManagedClaudeGateway {
  constructor(private readonly baseUrl = 'http://localhost:8787') {}

  async registerSession(input: { runtime: 'claude-code'; cwd: string; label: string }): Promise<ManagedClaudeSession> {
    const response = await fetch(new URL('/v1/sessions', this.baseUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Gateway session registration failed with HTTP ${response.status}`);
    const data = await response.json() as { sessionId?: string; id?: string; seq?: number; currentSeq?: number };
    const sessionId = data.sessionId ?? data.id;
    if (!sessionId) throw new Error('Gateway session registration returned no session id');
    return { sessionId, afterSeq: data.seq ?? data.currentSeq ?? 0 };
  }

  async *stream(afterSeq: number, signal: AbortSignal): AsyncIterable<ManagedClaudeEvent> {
    const url = new URL('/v1/stream', this.baseUrl);
    url.searchParams.set('after', String(afterSeq));
    const connectAbort = new AbortController();
    const relayAbort = () => connectAbort.abort(signal.reason);
    signal.addEventListener('abort', relayAbort, { once: true });
    const connectTimer = setTimeout(() => connectAbort.abort(new Error('Gateway event stream connection timed out')), 30_000);
    let response: Response;
    try {
      response = await fetch(url, { headers: { accept: 'text/event-stream, application/x-ndjson' }, signal: connectAbort.signal });
    } catch (error) {
      clearTimeout(connectTimer);
      signal.removeEventListener('abort', relayAbort);
      throw error;
    }
    clearTimeout(connectTimer);
    if (!response.ok || !response.body) {
      signal.removeEventListener('abort', relayAbort);
      throw new Error(`Gateway event stream failed with HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        for (const line of lines) {
          const event = parseStreamLine(line);
          if (event) yield event;
        }
      }
      const trailing = parseStreamLine(pending);
      if (trailing) yield trailing;
    } finally {
      signal.removeEventListener('abort', relayAbort);
      await reader.cancel().catch(() => undefined);
    }
  }

  async endSession(sessionId: string): Promise<void> {
    const response = await fetch(new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/end`, this.baseUrl), { method: 'POST', signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Gateway session end failed with HTTP ${response.status}`);
  }
}

export interface ClaudeLaunchOptions {
  cwd?: string;
  label: string;
  command?: string;
  args?: string[];
  gatewayUrl?: string;
  gateway?: ManagedClaudeGateway;
  hookScriptPath?: string;
}

export async function runManagedClaude(options: ClaudeLaunchOptions): Promise<number> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const gatewayUrl = options.gatewayUrl ?? 'http://localhost:8787';
  const gateway = options.gateway ?? new HttpManagedClaudeGateway(gatewayUrl);
  // Fail before launching Claude if the Gateway cannot register the session.
  const session = await gateway.registerSession({ runtime: 'claude-code', cwd, label: options.label });
  const streamAbort = new AbortController();
  let settingsDir: string | undefined;
  let child: ChildProcess | undefined;
  let streamTask: Promise<void> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  let onSigint: (() => void) | undefined;
  let onSigterm: (() => void) | undefined;
  try {
    settingsDir = await mkdtemp(join(tmpdir(), 'agentree-claude-'));
    const settingsPath = join(settingsDir, 'settings.json');
    const hookScriptPath = options.hookScriptPath ?? defaultHookScriptPath();
    const tsxLoader = hookScriptPath.endsWith('.ts') ? ' --import tsx' : '';
    const hookCommand = `${shellQuote(process.execPath)}${tsxLoader} ${shellQuote(hookScriptPath)}`;
    await writeFile(settingsPath, JSON.stringify(createClaudeHookSettings(hookCommand)), { mode: 0o600 });

    const claudeArgs = options.args ?? [];
    if (claudeArgs.includes('--settings')) throw new Error('Managed Claude owns --settings for its hook configuration');
    child = spawn(options.command ?? 'claude', ['--settings', settingsPath, ...claudeArgs], {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, HARNESS_GATEWAY_URL: gatewayUrl, HARNESS_SESSION_ID: session.sessionId },
    });
    const managedChild = child;
    const killChild = () => {
      if (stopping) return;
      stopping = true;
      process.stderr.write('\u001b[31m已被管理员终止\u001b[0m\n');
      managedChild.kill('SIGTERM');
      killTimer = setTimeout(() => managedChild.kill('SIGKILL'), 3000);
    };

    streamTask = (async () => {
      for await (const event of gateway.stream(session.afterSeq, streamAbort.signal)) {
        if (event.type === 'session.killed' && event.sessionId === session.sessionId) killChild();
      }
      if (!streamAbort.signal.aborted) throw new Error('Gateway event stream closed unexpectedly');
    })().catch(error => {
      if (!streamAbort.signal.aborted) {
        process.stderr.write(`[Harness] Gateway event stream failed; stopping managed session (${error instanceof Error ? error.message : String(error)}).\n`);
        killChild();
      }
    });

    onSigint = () => managedChild.kill('SIGINT');
    onSigterm = () => managedChild.kill('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    return await waitForExit(child);
  } finally {
    streamAbort.abort();
    if (onSigint) process.off('SIGINT', onSigint);
    if (onSigterm) process.off('SIGTERM', onSigterm);
    if (killTimer) clearTimeout(killTimer);
    await streamTask;
    await gateway.endSession(session.sessionId).catch(error => {
      process.stderr.write(`[Harness] Could not report session end: ${error instanceof Error ? error.message : String(error)}\n`);
    });
    if (settingsDir) await rm(settingsDir, { recursive: true, force: true });
  }
}

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit(code ?? (signal === 'SIGINT' ? 130 : 1)));
  });
}

function parseStreamLine(line: string): ManagedClaudeEvent | undefined {
  const data = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
  if (!data || data.startsWith(':') || data.startsWith('event:') || data.startsWith('id:')) return undefined;
  let event: ManagedClaudeEvent;
  try { event = JSON.parse(data) as ManagedClaudeEvent; }
  catch { throw new Error('Gateway stream returned malformed event JSON'); }
  if (typeof event.seq !== 'number' || typeof event.type !== 'string') throw new Error('Gateway stream event is missing seq or type');
  return event;
}

function defaultHookScriptPath(): string {
  const current = fileURLToPath(import.meta.url);
  const ext = current.endsWith('.ts') ? '.ts' : '.js';
  return join(dirname(current), `claude-pre-tool-hook${ext}`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
