import { DomainError, type Scope, type WorkspaceRoot } from '../../contracts/src/index.js';

type SpatialScope = { type: 'folder' | 'file'; path: string; rootId?: string };

function fail(message: string): never {
  throw new DomainError('SCOPE', message);
}

function normalizePath(path: string, type: 'folder' | 'file'): string {
  if (typeof path !== 'string' || path.length === 0) fail('Path must not be empty');
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)) {
    fail('Path must be root-relative');
  }
  const segments = path.replace(/\\/g, '/').split('/');
  if (segments.some((segment) => segment === '..')) fail('Parent traversal is not allowed');
  const normalized = segments.filter((segment) => segment !== '' && segment !== '.').join('/');
  if (type === 'file' && normalized.length === 0) fail('File path must not normalize to the root');
  return type === 'folder' && normalized.length === 0 ? '.' : normalized;
}

/** Canonicalize a workspace-relative scope without touching the filesystem. */
export function normalizeScope(scope: Scope, roots: WorkspaceRoot[]): Scope {
  if (scope.type !== 'folder' && scope.type !== 'file') return scope;

  const source = scope;
  const rootId = source.rootId;
  let resolvedRootId = rootId;
  if (roots.length === 1) {
    if (rootId !== undefined && rootId !== roots[0].id) fail('Unknown root');
    resolvedRootId = roots[0].id;
  } else if (roots.length > 1) {
    if (rootId === undefined) fail('rootId is required when a workspace has multiple roots');
    if (!roots.some((root) => root.id === rootId)) fail('Unknown root');
  } else if (rootId !== undefined) {
    fail('Unknown root');
  }

  const result = { type: scope.type, path: normalizePath(scope.path, scope.type), ...(resolvedRootId === undefined ? {} : { rootId: resolvedRootId }) };
  return result as Scope;
}

function spatial(scope: Scope): scope is SpatialScope {
  return scope.type === 'folder' || scope.type === 'file';
}

function rootDisjoint(a: SpatialScope, b: SpatialScope): boolean {
  return a.rootId !== undefined && b.rootId !== undefined && a.rootId !== b.rootId;
}

/** Whether two scopes may refer to any of the same context. */
export function scopesOverlap(a: Scope, b: Scope): boolean {
  if (a.type === 'workspace' || b.type === 'workspace') return true;
  if (a.type === 'task' && b.type === 'task') return a.taskId === b.taskId;
  if (a.type === 'task' || b.type === 'task') return true;
  if (!spatial(a) || !spatial(b) || rootDisjoint(a, b)) return false;

  const left = normalizePath(a.path, a.type);
  const right = normalizePath(b.path, b.type);
  if (a.type === 'file' && b.type === 'file') return left === right;
  if (a.type === 'file') return right === '.' || left.startsWith(`${right}/`) || left === right;
  if (b.type === 'file') return left === '.' || right.startsWith(`${left}/`) || right === left;
  return left === '.' || right === '.' || left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/** Stable identity for a decision key at its canonical location scope. */
export function decisionIdentity(key: string, scope: Scope): string {
  let identity: unknown[];
  if (scope.type === 'workspace') identity = [key, 'workspace'];
  else if (scope.type === 'task') identity = [key, 'task', scope.taskId];
  else identity = [key, scope.type, (scope as SpatialScope).rootId ?? null, normalizePath(scope.path, scope.type)];
  return JSON.stringify(identity);
}
