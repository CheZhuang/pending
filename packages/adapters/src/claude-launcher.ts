import { randomUUID } from 'node:crypto';
import { nativeMcpConfig } from './native-config.js';
import { homedir } from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createClaudeHookSettings } from './claude-settings.js';

export interface ManagedClaudeSession {
  sessionId: string;
  afterSeq: number;
  sessionToken?: string;
}

export interface ManagedClaudeEvent {
  seq: number;
  type: string;
  sessionId?: string;
}

export interface ManagedClaudeGateway {
  registerSession(input: { runtime: 'claude-code'; cwd: string; label: string; nativeId?:string; branchId?:string }): Promise<ManagedClaudeSession>;
  stream(afterSeq: number, signal: AbortSignal): AsyncIterable<ManagedClaudeEvent>;
  endSession(sessionId: string, exit?: { exitCode: number | null; signal: string | null }): Promise<void>;
}

/** REST bridge for the session/stream routes described by the shared gateway plan. */
export class HttpManagedClaudeGateway implements ManagedClaudeGateway {
  private sessionToken?: string;

  constructor(
    private readonly baseUrl = 'http://localhost:8787',
    private readonly adminToken = process.env.HARNESS_ADMIN_TOKEN,
  ) {}

  async registerSession(input: { runtime: 'claude-code'; cwd: string; label: string; nativeId?:string; branchId?:string }): Promise<ManagedClaudeSession> {
    const response = await fetch(new URL('/v1/sessions', this.baseUrl), {
      method: 'POST', headers: {
        'content-type': 'application/json',
        ...(this.adminToken ? { authorization: `Bearer ${this.adminToken}` } : {}),
      }, body: JSON.stringify(input), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Gateway session registration failed with HTTP ${response.status}`);
    const data = await response.json() as { sessionId?: string; id?: string; seq?: number; currentSeq?: number; sessionToken?: string };
    const sessionId = data.sessionId ?? data.id;
    if (!sessionId) throw new Error('Gateway session registration returned no session id');
    if(!data.sessionToken) throw new Error('Gateway returned no session credential');
    this.sessionToken = data.sessionToken;
    return { sessionId, afterSeq: data.seq ?? data.currentSeq ?? 0, ...(data.sessionToken ? { sessionToken: data.sessionToken } : {}) };
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
      response = await fetch(url, { headers: {
        accept: 'text/event-stream, application/x-ndjson',
        ...(this.sessionToken ? { authorization: `Bearer ${this.sessionToken}` } : {}),
      }, signal: connectAbort.signal });
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

  async endSession(sessionId: string, exit?: { exitCode: number | null; signal: string | null }): Promise<void> {
    const response = await fetch(new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/end`, this.baseUrl), {
      method: 'POST',
      headers: {
        ...(this.sessionToken ? { authorization: `Bearer ${this.sessionToken}` } : {}),
        ...(exit ? { 'content-type': 'application/json' } : {}),
      },
      ...(exit ? { body: JSON.stringify(exit) } : {}),
      signal: AbortSignal.timeout(5_000),
    });
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
  databasePath?: string;
  branchId?: string;
}

export async function runManagedClaude(options: ClaudeLaunchOptions): Promise<number> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const gatewayUrl = options.gatewayUrl ?? 'http://localhost:8787';
  const gateway = options.gateway ?? new HttpManagedClaudeGateway(gatewayUrl);
  // Fail before launching Claude if the Gateway cannot register the session.
  const nativeId=randomUUID();
  const session = await gateway.registerSession({ runtime: 'claude-code', cwd, label: options.label, nativeId, branchId:options.branchId });
  const streamAbort = new AbortController();
  let settingsDir: string | undefined;
  let child: ChildProcess | undefined;
  let childExit: { exitCode: number | null; signal: string | null } | undefined;
  let streamTask: Promise<void> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  let onSigint: (() => void) | undefined;
  let onSigterm: (() => void) | undefined;
  try {
    settingsDir = await mkdtemp(join(tmpdir(), 'agentree-claude-'));
    const settingsPath = join(settingsDir, 'settings.json');
    const hookScriptPath = options.hookScriptPath ?? defaultHookScriptPath();
    const tsxLoader = hookScriptPath.endsWith('.ts') ? ` --import ${shellQuote(import.meta.resolve('tsx'))}` : '';
    const hookCommand = `${shellQuote(process.execPath)}${tsxLoader} ${shellQuote(hookScriptPath)}`;
    await writeFile(settingsPath, JSON.stringify(createClaudeHookSettings(hookCommand)), { mode: 0o600 });

    const mcpPath=join(settingsDir,'mcp.json');
    const database=options.databasePath??process.env.AGENTREE_DATABASE_PATH??join(process.env.GATEWAY_DATA_DIR??join(homedir(),'.local','share','agentree'),'gateway.sqlite');
    await writeFile(mcpPath,JSON.stringify({mcpServers:{agentree:nativeMcpConfig(database,{gatewayUrl,sessionId:session.sessionId,sessionToken:session.sessionToken??''})}}),{mode:0o600});
    const claudeArgs = options.args ?? [];
    if(claudeArgs.some(arg=>/^--(settings|session-id|resume|continue|mcp-config)(=|$)/.test(arg)||arg==='-r'||arg==='-c')) throw new Error('Managed Claude owns native identity and configuration; start a fresh session');
    if (claudeArgs.includes('--settings')) throw new Error('Managed Claude owns --settings for its hook configuration');
    const { HARNESS_ADMIN_TOKEN: _adminToken, HARNESS_SESSION_TOKEN: _priorSessionToken, ...childEnv } = process.env;
    child = spawn(options.command ?? 'claude', ['--settings', settingsPath, '--session-id',nativeId,'--mcp-config',mcpPath, ...claudeArgs], {
      cwd,
      stdio: 'inherit',
      env: { ...childEnv, HARNESS_GATEWAY_URL: gatewayUrl, HARNESS_SESSION_ID: session.sessionId,
        ...(session.sessionToken ? { HARNESS_SESSION_TOKEN: session.sessionToken } : {}) },
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
        if ((event.type === 'session.kill-requested' || event.type === 'session.killed') && event.sessionId === session.sessionId) killChild();
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
    return await waitForExit(child, exit => { childExit = exit; });
  } finally {
    streamAbort.abort();
    if (onSigint) process.off('SIGINT', onSigint);
    if (onSigterm) process.off('SIGTERM', onSigterm);
    if (killTimer) clearTimeout(killTimer);
    await streamTask;
    // Only report an end after observing the child exit. A spawn error is not
    // evidence that the managed process exited, so leave that session for recovery.
    if (childExit) await gateway.endSession(session.sessionId, childExit).catch(error => {
      process.stderr.write(`[Harness] Could not report session end: ${error instanceof Error ? error.message : String(error)}\n`);
    });
    if (settingsDir) await rm(settingsDir, { recursive: true, force: true });
  }
}

function waitForExit(
  child: ChildProcess,
  onExit: (exit: { exitCode: number | null; signal: string | null }) => void,
): Promise<number> {
  return new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      const exit = { exitCode: code, signal: signal === null ? null : String(signal) };
      onExit(exit);
      resolveExit(code ?? (signal === 'SIGINT' ? 130 : 1));
    });
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
