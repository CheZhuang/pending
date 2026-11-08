import type { AdapterCapabilities } from './index.js';
import type { DiscoveredProcess, ProcessInventory, ProcessIdentity } from '../../contracts/src/gateway.js';

/** OS enumeration is observation only. Missing fields mean unavailable, never inferred. */
export interface ProcessSnapshot extends ProcessIdentity {
  parentPid?: number;
  executable?: string;
  argv?: string[];
  commandLine?: string;
  cwd?: string;
}
export interface ProcessProvider { enumerate(): Promise<ProcessSnapshot[]> }
export interface ManagedProcessBinding { sessionId: string; runtime: string; process: ProcessIdentity }
export const metadataOnly: AdapterCapabilities = Object.freeze({ passiveObservation: false, managedSession: false, contextInjection: false, preExecutionInterception: false });

const basename = (path: string) => path.replaceAll('\\', '/').split('/').pop()!.toLowerCase();
/** Do not search arbitrary arguments: prompts can contain any product name. */
export function identifyProcess(p: ProcessSnapshot): { runtime: 'claude-code' | 'codex'; evidence: string } | undefined {
  const executable = basename(p.executable ?? p.argv?.[0] ?? '');
  if (/^(claude|codex)(\.exe)?$/.test(executable)) return { runtime: executable.startsWith('claude') ? 'claude-code' : 'codex', evidence: 'executable-name' };
  if (/^codex-(aarch64|x86_64)-(apple-darwin|unknown-linux-(gnu|musl)|pc-windows-msvc)(\.exe)?$/.test(executable))
    return { runtime:'codex', evidence:'executable-name' };
  if (/(^|\/)claude\/versions\/\d+\.\d+\.\d+[^/]*$/i.test(p.executable?.replaceAll('\\', '/') ?? '') && basename(p.argv?.[0] ?? '') === 'claude')
    return { runtime:'claude-code', evidence:'known-installation-path' };
  if (!/^(node|nodejs)(\.exe)?$/.test(executable)) return;
  // Recognize only an actual CLI entrypoint, not -e, --eval, preload modules or shell text.
  const script = p.argv?.[1]?.replaceAll('\\', '/');
  if (!script || script.startsWith('-')) return;
  if (/(^|\/)@anthropic-ai\/claude-code\/cli\.js$/i.test(script)) return { runtime: 'claude-code', evidence: 'official-node-entrypoint' };
  if (/(^|\/)@openai\/codex\/bin\/codex\.js$/i.test(script)) return { runtime: 'codex', evidence: 'official-node-entrypoint' };
}
export const sameProcess = (a: ProcessIdentity, b: ProcessIdentity) => a.pid === b.pid && !!a.startTime && a.startTime === b.startTime;

/** Ephemeral inventory: replacement on every scan, including failure. No lifecycle DB. */
export class ProcessDiscovery {
  private inventory: ProcessInventory = { processes: [], status: 'initializing' };
  private pending?: Promise<ProcessInventory>;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private generation = 0;
  constructor(private readonly provider: ProcessProvider, private readonly bindings: () => ManagedProcessBinding[] = () => [], private readonly timeoutMs = 15000) {}
  current(): ProcessInventory {
    const bindings = this.bindings();
    return { ...this.inventory, processes: this.inventory.processes.map(p => {
      const matches = bindings.filter(b => sameProcess(b.process, p) && (b.runtime === p.runtime || (p.runtime === 'codex' && b.runtime === 'codex-app-server')));
      return { ...p, managedSessionId: matches.length === 1 ? matches[0]!.sessionId : undefined };
    }) };
  }
  start(intervalMs = 5000): void {
    if (this.timer || this.stopped) return;
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, intervalMs);
    this.timer.unref();
  }
  refresh(): Promise<ProcessInventory> {
    if (this.stopped) return Promise.resolve(this.current());
    return this.pending ??= this.scan().finally(() => { this.pending = undefined; });
  }
  private async scan(): Promise<ProcessInventory> {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const snapshots = await Promise.race([
        this.provider.enumerate(),
        new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('Enumeration timed out')), this.timeoutMs); deadline.unref(); }),
      ]);
      const generation = ++this.generation;
      const found = new Map<string, DiscoveredProcess>();
      for (const p of snapshots) {
        if (!Number.isSafeInteger(p.pid) || p.pid <= 0) continue;
        const identified = identifyProcess(p);
        if (!identified) continue;
        const id = p.startTime ? `${p.pid}:${p.startTime}` : `${p.pid}:unknown:${generation}`;
        found.set(id, { ...p, ...identified, id, identityReliable: !!p.startTime, capabilities: { ...metadataOnly }, nativeObservation: 'unavailable' });
      }
      // npm Codex starts a native binary beneath its official Node entrypoint.
      // Keep the wrapper's stable identity (the PID known to the launcher). Do
      // not collapse arbitrary ancestors: agents can independently spawn agents.
      for (const [id, child] of found) {
        const parent = [...found.values()].find(p => p.pid === child.parentPid);
        if (parent?.evidence === 'official-node-entrypoint' && child.evidence === 'executable-name' && parent.runtime === child.runtime)
          found.delete(id);
      }
      if (!this.stopped) this.inventory = { status: 'ok', scannedAt: new Date().toISOString(), processes: [...found.values()] };
    } catch {
      // Never present an old successful snapshot as currently running after a failed scan.
      if (!this.stopped) this.inventory = { status: 'unavailable', scannedAt: new Date().toISOString(), processes: [], message: 'Process enumeration unavailable; check local OS permissions.' };
    } finally { clearTimeout(deadline); }
    return this.current();
  }
  async close(): Promise<void> { this.stopped = true; clearInterval(this.timer); await this.pending; }
}
