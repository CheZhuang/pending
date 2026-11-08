import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { after, test } from 'node:test';
import { identifyProcess, ProcessDiscovery, sameProcess, type ManagedProcessBinding, type ProcessSnapshot } from './process-discovery.js';
import { linuxStartTime, LocalProcessProvider, nativeStartTime, splitCommandLine } from './process-platform.js';

const tempDirs: string[] = [];
after(async () => { await Promise.all(tempDirs.map(path => rm(path, { recursive: true, force: true }))); });

const identity = (pid: number, startTime = `birth:${pid}`) => ({ pid, startTime });
const processRow = (overrides: Partial<ProcessSnapshot> = {}): ProcessSnapshot => ({
  ...identity(42), executable: '/usr/local/bin/claude', argv: ['claude'], ...overrides,
});

test('identifies native executables and official Node CLI entrypoints across platform path styles', () => {
  assert.equal(identifyProcess(processRow())?.runtime, 'claude-code');
  assert.equal(identifyProcess(processRow({ executable: 'C:\\Program Files\\Codex\\codex.exe' }))?.runtime, 'codex');
  assert.equal(identifyProcess(processRow({ executable: '/usr/bin/node', argv: ['node', '/home/u/node_modules/@anthropic-ai/claude-code/cli.js'] }))?.runtime, 'claude-code');
  assert.equal(identifyProcess(processRow({ executable: 'C:\\Program Files\\node.exe', argv: ['node.exe', 'C:\\Users\\u\\node_modules\\@openai\\codex\\bin\\codex.js'] }))?.runtime, 'codex');
  assert.equal(identifyProcess(processRow({ executable: '/usr/bin/nodejs', argv: ['nodejs', '/x/node_modules/@openai/codex/bin/codex.js'] }))?.evidence, 'official-node-entrypoint');
  assert.deepEqual(identifyProcess(processRow({ executable: '/home/user/.local/share/claude/versions/2.1.22', argv: ['claude'] })),
    { runtime: 'claude-code', evidence: 'known-installation-path' });
  assert.deepEqual(identifyProcess(processRow({ executable: '/opt/codex/codex-aarch64-apple-darwin', argv: ['codex-aarch64-apple-darwin'] })),
    { runtime: 'codex', evidence: 'executable-name' });
});

test('does not identify arbitrary Node scripts, shells, or product names in prompts', () => {
  for (const row of [
    processRow({ executable: '/usr/bin/node', argv: ['node', '-e', 'launch claude'] }),
    processRow({ executable: '/usr/bin/node', argv: ['node', '/tmp/untrusted.js', 'codex'] }),
    processRow({ executable: '/bin/bash', argv: ['bash', '-c', 'claude'] }),
    processRow({ executable: '/usr/bin/python', argv: ['python', 'please run codex'] }),
    processRow({ executable: '/usr/bin/node', argv: ['node', '--require', '@anthropic-ai/claude-code/cli.js'] }),
  ]) assert.equal(identifyProcess(row), undefined);
});

test('Linux birth identity handles comm containing spaces and parentheses', () => {
  // Fields after the final ')' start at field 3; starttime is field 22 (index 19).
  const stat = `321 (node (claude worker)) S ${Array.from({ length: 19 }, (_, i) => i === 18 ? '987654' : String(i + 1)).join(' ')}`;
  assert.equal(linuxStartTime(stat, 'boot-uuid\n'), 'linux:boot-uuid:987654');
  assert.throws(() => linuxStartTime('321 (broken) S 1 2', 'boot'), /Invalid proc stat/);
  assert.equal(sameProcess(identity(321, 'birth-a'), identity(321, 'birth-b')), false, 'PID reuse must not match');
  assert.equal(sameProcess({ pid: 321 }, { pid: 321 }), false, 'unknown start times are never a reliable binding');
});

test('inventory deduplicates identical process identities and only adds an exact unique managed binding', async () => {
  const first = processRow({ pid: 8, startTime: 'birth-1' });
  const second = processRow({ pid: 8, startTime: 'birth-2', executable: '/usr/bin/codex' });
  const discovery = new ProcessDiscovery({ enumerate: async () => [first, first, second] }, () => [
    { sessionId: 'session-1', runtime: 'claude-code', process: identity(8, 'birth-1') },
  ]);
  const result = await discovery.refresh();
  assert.equal(result.processes.length, 2);
  assert.equal(result.processes.find(p => p.startTime === 'birth-1')?.managedSessionId, 'session-1');
  assert.equal(result.processes.find(p => p.startTime === 'birth-2')?.managedSessionId, undefined);
  await discovery.close();
});

test('unreliable, runtime-mismatched, or ambiguous bindings remain unlinked and discovery grants no capabilities', async () => {
  const p = processRow({ pid: 18, startTime: 'birth-exact' });
  const make = (bindings: ManagedProcessBinding[]) => new ProcessDiscovery(
    { enumerate: async () => [p] }, () => bindings,
  );
  const capabilities = { passiveObservation: false, managedSession: false, contextInjection: false, preExecutionInterception: false };
  const mismatch = make([{ sessionId: 'wrong-runtime', runtime: 'codex-app-server', process: identity(18, 'birth-exact') }]);
  const mismatchResult = await mismatch.refresh();
  assert.equal(mismatchResult.processes[0]?.managedSessionId, undefined);
  assert.deepEqual(mismatchResult.processes[0]?.capabilities, capabilities);
  assert.equal(mismatchResult.processes[0]?.nativeObservation, 'unavailable');
  await mismatch.close();

  const ambiguous = make([
    { sessionId: 'a', runtime: 'claude-code', process: identity(18, 'birth-exact') },
    { sessionId: 'b', runtime: 'claude-code', process: identity(18, 'birth-exact') },
  ]);
  assert.equal((await ambiguous.refresh()).processes[0]?.managedSessionId, undefined);
  await ambiguous.close();

  const unreliable = make([{ sessionId: 'no-birth', runtime: 'claude-code', process: { pid: 18 } }]);
  assert.equal((await unreliable.refresh()).processes[0]?.managedSessionId, undefined);
  await unreliable.close();
});

test('refresh replaces exited processes, reports failures without stale data, and recovers after partial-permission error', async () => {
  let next: () => Promise<ProcessSnapshot[]> = async () => [processRow()];
  const discovery = new ProcessDiscovery({ enumerate: () => next() });
  assert.equal((await discovery.refresh()).processes.length, 1);
  next = async () => [];
  assert.equal((await discovery.refresh()).processes.length, 0, 'exited processes disappear on successful scan');
  next = async () => { throw new Error('permission denied for some process'); };
  const failed = await discovery.refresh();
  assert.equal(failed.status, 'unavailable');
  assert.deepEqual(failed.processes, [], 'failed scan cannot leave stale process rows visible');
  assert.match(failed.message ?? '', /permissions/);
  next = async () => [processRow({ pid: 99 })];
  assert.equal((await discovery.refresh()).status, 'ok');
  assert.equal((await discovery.refresh()).processes[0]?.pid, 99);
  await discovery.close();
});

test('overlapping refresh requests share one scan', async () => {
  let calls = 0;
  let release!: (rows: ProcessSnapshot[]) => void;
  const discovery = new ProcessDiscovery({ enumerate: () => {
    calls++;
    return new Promise(resolve => { release = resolve; });
  } });
  const first = discovery.refresh();
  const second = discovery.refresh();
  assert.equal(calls, 1);
  release([processRow()]);
  assert.deepEqual(await first, await second);
  await discovery.close();
});

test('a stalled enumeration reports unavailable and shutdown completes', async () => {
  const discovery = new ProcessDiscovery({enumerate:() => new Promise(() => {})}, () => [], 10);
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    assert.equal((await discovery.refresh()).status, 'unavailable');
    await discovery.close();
  } finally { clearTimeout(keepAlive); }
});

test('startup scanning and periodic refresh remove exited processes without an explicit refresh', async () => {
  let rows = [processRow()];
  let scans = 0;
  const discovery = new ProcessDiscovery({enumerate:async () => { scans++; return rows; }});
  discovery.start(10);
  try {
    await discovery.refresh();
    assert.equal(discovery.current().processes.length, 1);
    rows = [];
    const deadline = Date.now() + 1000;
    while (discovery.current().processes.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(scans >= 2);
    assert.equal(discovery.current().processes.length, 0);
  } finally { await discovery.close(); }
});

test('partially readable metadata stays visible without PID continuity or control', async () => {
  const discovery = new ProcessDiscovery({ enumerate: async () => [
    {pid:88, executable:'/usr/bin/claude'},
    {pid:89, executable:'/usr/bin/node'},
  ] }, () => [{sessionId:'old',runtime:'claude-code',process:{pid:88,startTime:'old-birth'}}]);
  const first = (await discovery.refresh()).processes;
  const second = (await discovery.refresh()).processes;
  assert.equal(first.length, 1, 'a generic Node with unreadable argv is not an identified agent');
  assert.equal(first[0]!.identityReliable, false);
  assert.equal(first[0]!.managedSessionId, undefined);
  assert.equal(first[0]!.cwd, undefined);
  assert.notEqual(first[0]!.id, second[0]!.id, 'an unknown birth must not imply continuity across scans');
  assert.ok(Object.values(first[0]!.capabilities).every(value => value === false));
  await discovery.close();
});

test('official Node wrapper collapses its direct native child, while an independent child stays discoverable', async () => {
  const rows = [
    processRow({ pid: 70, executable: '/usr/bin/node', argv: ['node', '/x/node_modules/@openai/codex/bin/codex.js'] }),
    processRow({ pid: 71, parentPid: 70, executable: '/usr/bin/codex', argv: ['codex'] }),
    processRow({ pid: 72, parentPid: 999, executable: '/usr/bin/claude', argv: ['claude'] }),
  ];
  const discovery = new ProcessDiscovery({ enumerate: async () => rows });
  const processes = (await discovery.refresh()).processes;
  assert.deepEqual(processes.map(p => p.pid).sort(), [70, 72]);
  assert.equal(processes.find(p => p.pid === 70)?.runtime, 'codex');
  assert.equal(processes.find(p => p.pid === 72)?.runtime, 'claude-code');
  await discovery.close();
});

test('Windows command-line splitting preserves quoted executable and argument paths', () => {
  assert.deepEqual(splitCommandLine('"C:\\Program Files\\node.exe" "C:\\Users\\u\\node_modules\\@openai\\codex\\bin\\codex.js" --version'), [
    'C:\\Program Files\\node.exe', 'C:\\Users\\u\\node_modules\\@openai\\codex\\bin\\codex.js', '--version',
  ]);
});

test('Linux local provider observes an official Node CLI process with birth identity and removes it after exit', { skip: process.platform !== 'linux' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pendingtree-discovery-provider-'));
  tempDirs.push(directory);
  const script = join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  await mkdir(join(directory, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
  await writeFile(script, 'setInterval(() => {}, 1000);\n');
  const child = spawn(process.execPath, [script], { cwd: directory, stdio: 'ignore' });
  try {
    assert.ok(child.pid);
    const provider = new LocalProcessProvider();
    const deadline = Date.now() + 10_000;
    let discovered: ProcessSnapshot | undefined;
    while (Date.now() < deadline && !discovered) {
      discovered = (await provider.enumerate()).find(p => p.pid === child.pid);
      if (!discovered) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(discovered, 'enumerator should find the spawned CLI process');
    assert.match(discovered.startTime ?? '', /^linux:/);
    assert.equal(discovered.cwd, directory);
    assert.ok(discovered.argv?.some(arg => arg.endsWith('@openai/codex/bin/codex.js')));
    const currentStart = await nativeStartTime(process.pid);
    assert.ok(currentStart);
    assert.equal(await nativeStartTime(process.pid), currentStart, 'same process birth identity remains stable');

    child.kill('SIGTERM');
    await new Promise<void>(resolve => child.once('exit', () => resolve()));
    let stillListed = true;
    const exitDeadline = Date.now() + 5000;
    while (Date.now() < exitDeadline && stillListed) {
      stillListed = (await provider.enumerate()).some(p => p.pid === child.pid);
      if (stillListed) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(stillListed, false, 'exited process disappears from next inventory after OS process table catches up');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('native birth identity is stable for the current macOS or Windows process', { skip: process.platform !== 'darwin' && process.platform !== 'win32' }, async () => {
  const first = await nativeStartTime(process.pid);
  const second = await nativeStartTime(process.pid);
  assert.ok(first, 'native process query should return a start identity');
  assert.equal(second, first);
});
