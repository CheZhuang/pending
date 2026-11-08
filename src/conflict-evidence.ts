import { execFile as nodeExecFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { devNull } from 'node:os';
import type { Conflict, FileRef, Workspace } from '../packages/contracts/src/index.js';

export interface ConflictFileEvidence {
  file: FileRef;
  capturedAt: string;
  currentState: { exists: boolean; bytes?: number; modifiedAt?: string; sha256?: string; unavailableReason?: string };
  gitStatus: string;
  workingTreeDiff: string;
  recentChanges: Array<{ commit: string; date: string; subject: string }>;
  gitError?: string;
}

const CLIP = 16_000;
const HASH_LIMIT = 8 * 1024 * 1024;
const MAX_FILES = 12;
const FILE_DEADLINE_MS = 2_000;
const COMMAND_TIMEOUT_MS = 650;
const MAX_BUFFER = 256 * 1024;
const MAX_CONCURRENT_GIT = 4;
const execFile = promisify(nodeExecFile);

/** Optional process runner for deterministic tests and embedders. */
export type GitRunner = (cwd: string, args: string[], timeoutMs: number, deadline?: number) => Promise<string>;

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>, deadline: number): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>(resolveWaiter => this.waiters.push(resolveWaiter));
    else this.active++;
    if (Date.now() >= deadline) {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
      throw new Error('Evidence collection deadline exceeded');
    }
    try { return await fn(); }
    finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }
}
// Shared across calls: requests cannot multiply the number of Git processes without bound.
const gitSlots = new Semaphore(MAX_CONCURRENT_GIT);

async function defaultGitRunner(cwd: string, args: string[], timeoutMs: number, deadline = Date.now() + timeoutMs): Promise<string> {
  return gitSlots.run(async () => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error('Evidence collection deadline exceeded');
    const result = await execFile('git', ['--no-optional-locks', '--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
      encoding: 'utf8', timeout: Math.min(timeoutMs, remainingMs), killSignal: 'SIGKILL', maxBuffer: MAX_BUFFER,
      windowsHide: true,
    });
    return result.stdout.trimEnd();
  }, deadline);
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Resolve real paths and reject both lexical traversal and symlinks escaping the workspace. */
async function safePath(workspace: Workspace, file: FileRef): Promise<{ root: string; absolute: string } | undefined> {
  const declaredRoot = workspace.roots.find(item => item.id === file.rootId)?.path;
  if (!declaredRoot || isAbsolute(file.path) || file.path.includes('\\') || /^[A-Za-z]:/.test(file.path) || file.path.startsWith('//')) return undefined;
  try {
    const root = await realpath(resolve(declaredRoot));
    const lexical = resolve(root, file.path);
    if (!within(root, lexical)) return undefined;
    // For missing files, resolve the nearest existing parent so dangling/future filenames
    // still get checked against symlinked ancestors.
    let probe = lexical;
    const tail: string[] = [];
    while (true) {
      try { await lstat(probe); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') return undefined;
        const parent = resolve(probe, '..');
        if (parent === probe) return undefined;
        tail.unshift(probe.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
        probe = parent;
      }
    }
    const actualAncestor = await realpath(probe);
    const actual = resolve(actualAncestor, ...tail);
    if (!within(root, actual)) return undefined;
    return { root, absolute: actual };
  } catch { return undefined; }
}

function remaining(deadline: number): number {
  const ms = deadline - Date.now();
  if (ms <= 0) throw new Error('Evidence collection deadline exceeded');
  return Math.min(COMMAND_TIMEOUT_MS, ms);
}

function boundedGit(runner: GitRunner, cwd: string, args: string[], deadline: number): Promise<string> {
  const timeout = remaining(deadline);
  return new Promise<string>((resolveResult, rejectResult) => {
    const timer = setTimeout(() => rejectResult(new Error('Git command timed out')), timeout);
    runner(cwd, args, timeout, Date.now() + timeout).then(resolveResult, rejectResult).finally(() => clearTimeout(timer));
  });
}

async function collectOne(workspace: Workspace, file: FileRef, runner: GitRunner): Promise<ConflictFileEvidence> {
  const capturedAt = new Date().toISOString();
  const target = await safePath(workspace, file);
  if (!target) return { file, capturedAt, currentState: { exists: false, unavailableReason: 'File reference is outside its workspace root' }, gitStatus: '', workingTreeDiff: '', recentChanges: [] };
  const deadline = Date.now() + FILE_DEADLINE_MS;
  const currentState: ConflictFileEvidence['currentState'] = { exists: false };
  try {
    const info = await stat(target.absolute);
    currentState.exists = true;
    currentState.bytes = info.size;
    currentState.modifiedAt = info.mtime.toISOString();
    if (info.isFile() && info.size <= HASH_LIMIT) {
      try { currentState.sha256 = createHash('sha256').update(await readFile(target.absolute)).digest('hex'); }
      catch { currentState.unavailableReason = 'File could not be inspected'; }
    } else if (info.isFile()) currentState.unavailableReason = 'File exceeds the 8 MiB hashing limit';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') currentState.unavailableReason = 'File could not be inspected';
  }
  try {
    // Compare real paths on both sides: the workspace root is already resolved, and Git may
    // report the toplevel through a symlink (macOS /var -> /private/var) or another spelling.
    const repo = await realpath(resolve(await boundedGit(runner, target.root, ['rev-parse', '--show-toplevel'], deadline)));
    const repoPath = relative(repo, target.absolute).split(sep).join('/');
    if (!repoPath || !within(resolve(repo), resolve(repo, repoPath))) throw new Error('Workspace file is outside the Git checkout');
    const gitStatus = await boundedGit(runner, repo, ['status', '--short', '--untracked-files=all', '--', repoPath], deadline) || 'clean';
    let workingTreeDiff: string;
    if (gitStatus.startsWith('?? ')) {
      try {
        workingTreeDiff = await boundedGit(runner, repo, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', '--', devNull, repoPath], deadline);
      } catch (error) {
        // git diff --no-index returns 1 when it finds differences; the default runner's
        // rejected error carries the output, while test runners may expose it directly.
        if ((error as { code?: unknown })?.code !== 1) throw error;
        workingTreeDiff = typeof (error as { stdout?: unknown })?.stdout === 'string' ? (error as { stdout: string }).stdout : '';
      }
    } else {
      workingTreeDiff = await boundedGit(runner, repo, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--unified=3', 'HEAD', '--', repoPath], deadline);
    }
    let log = '';
    let gitError: string | undefined;
    try { log = await boundedGit(runner, repo, ['log', '-5', '--format=%H%x09%cI%x09%s', '--', repoPath], deadline); }
    catch (error) { gitError = error instanceof Error ? error.message : String(error); }
    const recentChanges = log.split('\n').filter(Boolean).map(line => {
      const [commit = '', date = '', ...subject] = line.split('\t');
      return { commit, date, subject: subject.join('\t') };
    });
    return { file, capturedAt, currentState, gitStatus, workingTreeDiff: workingTreeDiff.slice(0, CLIP), recentChanges, ...(gitError ? {gitError} : {}) };
  } catch (error) {
    return { file, capturedAt, currentState, gitStatus: 'unavailable', workingTreeDiff: '', recentChanges: [], gitError: error instanceof Error ? error.message : String(error) };
  }
}

/** Read-only best-effort evidence. Bounds file count, file hashing, Git concurrency, output, and per-file time. */
export async function collectConflictEvidence(workspace: Workspace, conflict: Conflict, runner: GitRunner = defaultGitRunner): Promise<ConflictFileEvidence[]> {
  return Promise.all(conflict.files.slice(0, MAX_FILES).map(file => collectOne(workspace, file, runner)));
}
