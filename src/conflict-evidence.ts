import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
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
function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 500, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trimEnd();
}
function safePath(workspace: Workspace, file: FileRef): { root: string; absolute: string } | undefined {
  const root = workspace.roots.find(item => item.id === file.rootId)?.path;
  if (!root || isAbsolute(file.path)) return undefined;
  const absolute = resolve(root, file.path);
  const rel = relative(resolve(root), absolute);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return { root: resolve(root), absolute };
}

/** Read-only, bounded best-effort evidence from each current workspace checkout. */
export function collectConflictEvidence(workspace: Workspace, conflict: Conflict): ConflictFileEvidence[] {
  return conflict.files.slice(0, 12).map(file => {
    const target = safePath(workspace, file);
    if (!target) return { file, capturedAt: new Date().toISOString(), currentState: { exists: false, unavailableReason: 'File reference is outside its workspace root' }, gitStatus: '', workingTreeDiff: '', recentChanges: [] };
    const currentState: ConflictFileEvidence['currentState'] = { exists: existsSync(target.absolute) };
    if (currentState.exists) {
      try {
        const stat = statSync(target.absolute);
        currentState.bytes = stat.size;
        currentState.modifiedAt = stat.mtime.toISOString();
        if (stat.isFile() && stat.size <= 8 * 1024 * 1024) currentState.sha256 = createHash('sha256').update(readFileSync(target.absolute)).digest('hex');
        else if (stat.isFile()) currentState.unavailableReason = 'File exceeds the 8 MiB hashing limit';
      } catch { currentState.unavailableReason = 'File could not be inspected'; }
    }
    try {
      const repo = git(target.root, ['rev-parse', '--show-toplevel']);
      const repoPath = relative(repo, target.absolute).split(sep).join('/');
      if (!repoPath || repoPath === '..' || repoPath.startsWith('../')) throw new Error('Workspace file is outside the Git checkout');
      const gitStatus = git(repo, ['status', '--short', '--untracked-files=all', '--', repoPath]) || 'clean';
      let workingTreeDiff = git(repo, ['diff', '--no-ext-diff', '--no-color', '--no-renames', '--unified=3', 'HEAD', '--', repoPath]);
      if (!workingTreeDiff && gitStatus.includes('??')) {
        try { workingTreeDiff = execFileSync('git', ['-C', repo, 'diff', '--no-index', '--no-ext-diff', '--no-color', '--unified=3', '--', '/dev/null', repoPath], { encoding: 'utf8', timeout: 500, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trimEnd(); }
        catch (error) { workingTreeDiff = (error as { stdout?: string }).stdout ?? ''; }
      }
      const recentChanges = git(repo, ['log', '-5', '--format=%H%x09%cI%x09%s', '--', repoPath]).split('\n').filter(Boolean).map(line => {
        const [commit = '', date = '', ...subject] = line.split('\t');
        return { commit, date, subject: subject.join('\t') };
      });
      return { file, capturedAt: new Date().toISOString(), currentState, gitStatus, workingTreeDiff: workingTreeDiff.slice(0, CLIP), recentChanges };
    } catch (error) {
      return { file, capturedAt: new Date().toISOString(), currentState, gitStatus: 'unavailable', workingTreeDiff: '', recentChanges: [], gitError: error instanceof Error ? error.message : String(error) };
    }
  });
}
