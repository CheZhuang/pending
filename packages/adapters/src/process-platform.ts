import si from 'systeminformation';
import { readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProcessProvider, ProcessSnapshot } from './process-discovery.js';

/** CommandLineToArgvW-style quoting, also suitable for ps command display paths.
 * This parses data only; no discovered string is ever executed. */
export function splitCommandLine(line: string): string[] {
  const args: string[] = [];
  let value = '', quoted = false, present = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '\\') {
      let count = 1;
      while (line[i + 1] === '\\') { count++; i++; }
      if (line[i + 1] === '"') {
        value += '\\'.repeat(Math.floor(count / 2));
        i++;
        if (count % 2) value += '"'; else quoted = !quoted;
      } else value += '\\'.repeat(count);
      present = true;
    } else if (c === '"') { quoted = !quoted; present = true; }
    else if (/\s/.test(c) && !quoted) { if (present) { args.push(value); value = ''; present = false; } }
    else { value += c; present = true; }
  }
  if (present) args.push(value);
  return args;
}

export function linuxStartTime(stat: string, bootId: string): string {
  // comm may contain spaces and parentheses. Fields after the last ')' start at field 3.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  if (!/^\d+$/.test(fields[19] ?? '')) throw new Error('Invalid proc stat');
  return `linux:${bootId.trim()}:${fields[19]}`;
}

/** Read precise birth identity, not systeminformation's elapsed-time approximation. */
export async function nativeStartTime(pid: number): Promise<string | undefined> {
  try {
    if (process.platform === 'linux') {
      const [stat, boot] = await Promise.all([readFile(`/proc/${pid}/stat`, 'utf8'), readFile('/proc/sys/kernel/random/boot_id', 'utf8')]);
      return linuxStartTime(stat, boot);
    }
    return (await nativeReader())?.(pid);
  } catch { return undefined; }
}
let reader: Promise<((pid: number) => string | undefined) | undefined> | undefined;
function nativeReader() {
  return reader ??= (async () => {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return;
    const { default: koffi } = await import('koffi');
    if (process.platform === 'darwin') {
      const lib = koffi.load('/usr/lib/libproc.dylib');
      const info = lib.func('int proc_pidinfo(int pid, int flavor, uint64_t arg, _Out_ void *buffer, int buffersize)');
      return (pid: number) => {
        const buffer = Buffer.alloc(136); // struct proc_bsdinfo, PROC_PIDTBSDINFO (3).
        if (info(pid, 3, 0, buffer, buffer.length) !== buffer.length) return;
        return `darwin:${buffer.readBigUInt64LE(120)}:${buffer.readBigUInt64LE(128)}`;
      };
    }
    const lib = koffi.load('kernel32.dll');
    const open = lib.func('void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)');
    const times = lib.func('int __stdcall GetProcessTimes(void *handle, _Out_ void *creation, _Out_ void *exit, _Out_ void *kernel, _Out_ void *user)');
    const close = lib.func('int __stdcall CloseHandle(void *handle)');
    return (pid: number) => {
      const handle = open(0x1000, 0, pid); // PROCESS_QUERY_LIMITED_INFORMATION; never write/signal rights.
      if (!handle) return;
      try {
        const creation = Buffer.alloc(8);
        if (!times(handle, creation, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8))) return;
        return `win32:${creation.readBigUInt64LE()}`;
      } finally { close(handle); }
    };
  })();
}

export class LocalProcessProvider implements ProcessProvider {
  private pending?: Promise<ProcessSnapshot[]>;
  enumerate(): Promise<ProcessSnapshot[]> {
    // A hung OS enumeration must not create another shell/native workload every tick.
    return this.pending ??= this.collect().finally(() => { this.pending = undefined; });
  }
  private async collect(): Promise<ProcessSnapshot[]> {
    if (!['linux', 'darwin', 'win32'].includes(process.platform)) throw new Error('Unsupported platform');
    const result = await si.processes();
    // Library returns an empty list on some enumeration errors.
    if (!result.list.length) throw new Error('Empty process inventory');
    const snapshots: ProcessSnapshot[] = [];
    // Small batches avoid unbounded open files on large hosts.
    for (let i = 0; i < result.list.length; i += 32) {
      const batch = await Promise.all(result.list.slice(i, i + 32).map(async row => {
        if (['dead', 'zombie'].includes(row.state)) return;
        let argv = splitCommandLine(`${row.command ?? ''} ${row.params ?? ''}`.trim());
        let executable = process.platform === 'win32' ? row.path || argv[0] : row.path ? join(row.path, argv[0] ?? '') : argv[0];
        let cwd: string | undefined;
        const startTime = await nativeStartTime(row.pid);
        if (process.platform === 'linux') {
          const [cmd, exe, directory] = await Promise.allSettled([readFile(`/proc/${row.pid}/cmdline`), readlink(`/proc/${row.pid}/exe`), readlink(`/proc/${row.pid}/cwd`)]);
          if (cmd.status === 'fulfilled') {
            argv = cmd.value.toString().split('\0');
            if (argv.at(-1) === '') argv.pop();
          }
          if (exe.status === 'fulfilled') executable = exe.value.replace(/ \(deleted\)$/, '');
          if (directory.status === 'fulfilled') cwd = directory.value;
        }
        // Reject metadata collected across an exit/reuse race.
        if (startTime && startTime !== await nativeStartTime(row.pid)) return;
        return { pid: row.pid, parentPid: row.parentPid, startTime, executable, argv, commandLine: argv.join(' '), cwd };
      }));
      for (const snapshot of batch) if (snapshot) snapshots.push(snapshot);
    }
    return snapshots;
  }
}
