import { isAbsolute, relative, resolve } from 'node:path';
import { DomainError, type FileRef, type WorkspaceRoot } from '../../contracts/src/index.js';

/** Canonical file identity only; this does not read or modify the filesystem. */
export function normalizeFile(file: FileRef, roots: WorkspaceRoot[]): FileRef {
  const declaredRoot = roots.find(root => root.id === file.rootId);
  if (!declaredRoot) throw new DomainError('PATH','Unknown workspace root');
  if (!file.path || file.path.startsWith('/') || file.path.startsWith('\\') || /^[A-Za-z]:/.test(file.path))
    throw new DomainError('PATH','File path must be root-relative');
  const segments = file.path.replace(/\\/g,'/').split('/');
  if (segments.some(segment => segment === '..')) throw new DomainError('PATH','Parent traversal is not allowed');
  const path = segments.filter(segment => segment && segment !== '.').join('/');
  if (!path) throw new DomainError('PATH','File path must not normalize to the workspace root');
  // Native observations choose the longest root. Declarations must use the
  // same identity when a workspace includes nested roots.
  const target = resolve(declaredRoot.path,path);
  let best = {root:declaredRoot,path};
  for (const root of roots) {
    const inside = relative(root.path,target).replace(/\\/g,'/');
    if (root.path.length > best.root.path.length && inside && inside !== '..' && !inside.startsWith('../') && !isAbsolute(inside))
      best = {root,path:inside};
  }
  return {rootId:best.root.id,path:best.path};
}
