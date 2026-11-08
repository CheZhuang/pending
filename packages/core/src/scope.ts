import { DomainError, type FileRef, type WorkspaceRoot } from '../../contracts/src/index.js';

/** Canonical file identity only; this does not read or modify the filesystem. */
export function normalizeFile(file: FileRef, roots: WorkspaceRoot[]): FileRef {
  if (!roots.some(root => root.id === file.rootId)) throw new DomainError('PATH','Unknown workspace root');
  if (!file.path || file.path.startsWith('/') || file.path.startsWith('\\') || /^[A-Za-z]:/.test(file.path))
    throw new DomainError('PATH','File path must be root-relative');
  const segments = file.path.replace(/\\/g,'/').split('/');
  if (segments.some(segment => segment === '..')) throw new DomainError('PATH','Parent traversal is not allowed');
  const path = segments.filter(segment => segment && segment !== '.').join('/');
  if (!path) throw new DomainError('PATH','File path must not normalize to the workspace root');
  return {rootId:file.rootId,path};
}
