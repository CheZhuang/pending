// Maps native file paths reported by agents (absolute, or relative to a cwd)
// onto canonical workspace-relative scopes `{ rootId, path }`.
// Pure lexical mapping: no filesystem access, no symlink resolution.
import { isAbsolute, relative, resolve } from 'node:path';
import type { FileRef, WorkspaceRoot } from '../../contracts/src/index.js';
import { normalizeFile } from '../../core/src/scope.js';

export interface RootedPath {
  rootId?: string;
  path: string;
}

function within(rootPath: string, target: string): string | undefined {
  const rel = relative(rootPath, target);
  if (rel === '' ) return '.';
  if (rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return rel.split('\\').join('/');
}

/**
 * Resolve a native path to a root-relative path.
 * - Absolute paths (or relative paths with a `cwd`) pick the longest matching root.
 * - Bare relative paths only resolve when the workspace has 0 or 1 roots.
 * Returns undefined for paths outside the workspace, unknown roots, or
 * relative paths that cannot be attributed to a known root.
 */
export function toRootedPath(nativePath: string, roots: WorkspaceRoot[], cwd?: string): RootedPath | undefined {
  if (typeof nativePath !== 'string' || nativePath.length === 0) return undefined;
  const absolute = isAbsolute(nativePath) ? nativePath : cwd && isAbsolute(cwd) ? resolve(cwd, nativePath) : undefined;

  if (absolute === undefined) {
    if (roots.length !== 1) return undefined;
    return canonical({ path: nativePath, rootId: roots[0]!.id }, roots);
  }

  let best: { root: WorkspaceRoot; rel: string } | undefined;
  for (const root of roots) {
    const rel = within(resolve(root.path), resolve(absolute));
    if (rel !== undefined && (!best || root.path.length > best.root.path.length)) best = { root, rel };
  }
  if (!best || best.rel === '.') return undefined; // outside workspace, or the root itself
  return canonical({ path: best.rel, rootId: best.root.id }, roots);
}

function canonical(path: RootedPath, roots: WorkspaceRoot[]): RootedPath | undefined {
  if (!path.rootId) return undefined;
  try {
    const file = normalizeFile(path as FileRef, roots);
    return { path: file.path, rootId: file.rootId };
  } catch {
    return undefined; // parent traversal, empty path, unknown root
  }
}

/** Parent folder of a root-relative file path ("." for top-level files). */
export function parentFolder(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '.' : path.slice(0, index);
}
