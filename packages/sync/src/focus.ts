// Extract rooted file evidence from normalized native activity. This mapping is
// for supervision visibility/conflict detection; it does not infer semantics.
import type { NormalizedEvent, WorkspaceRoot } from '../../contracts/src/index.js';
import { toRootedPath } from './paths.js';

export type Access = 'read' | 'write';
export interface Touch { path: string; rootId: string; access: Access; }
type Raw = { path: string; rootId?: string; access?: Access };
const WRITE_TOOLS = /^(edit|write|multiedit|notebookedit|apply_patch)$/i;
const READ_TOOLS = /^(read|grep|glob|ls|notebookread)$/i;
const WRITE_TYPE = /(write|edit|patch|change|create|delete|modif)/i;
function record(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined; }
const str = (value: unknown) => typeof value === 'string' && value.length > 0 ? value : undefined;

/** Read Claude hooks, normalized tool records and Codex file-change notifications. */
function rawPaths(event: NormalizedEvent): { cwd?: string; paths: Raw[] } {
  const payload = record(event.payload) ?? {}; const params = record(payload.params); const cwd = str(payload.cwd) ?? str(params?.cwd); const paths: Raw[] = [];
  if (Array.isArray(payload.touches)) for (const t of payload.touches.map(record)) {
    const path = str(t?.path); if (path) paths.push({ path, rootId: str(t?.rootId), access: t?.access === 'write' ? 'write' : 'read' });
  }
  const input = record(payload.tool_input) ?? record(payload.input); const toolPath = str(input?.file_path) ?? str(input?.notebook_path) ?? str(input?.path);
  if (toolPath) { const tool = str(payload.tool_name) ?? str(payload.tool) ?? ''; paths.push({ path: toolPath, access: WRITE_TOOLS.test(tool) ? 'write' : READ_TOOLS.test(tool) ? 'read' : undefined }); }
  for (const changes of [payload.changes, record(payload.item)?.changes, record(params?.item)?.changes]) if (Array.isArray(changes)) {
    for (const change of changes.map(record)) { const path = str(change?.path); if (path) paths.push({ path, access: 'write' }); }
  }
  return { cwd, paths };
}

/** Drop paths that cannot be attributed to one known workspace root. */
export function extractTouches(event: NormalizedEvent, roots: WorkspaceRoot[]): Touch[] {
  const { cwd, paths } = rawPaths(event); const touches = new Map<string, Touch>();
  for (const raw of paths) {
    const candidates = raw.rootId ? roots.filter((r) => r.id === raw.rootId) : roots;
    if (!candidates.length) continue;
    const rooted = toRootedPath(raw.path, candidates, cwd); if (!rooted?.rootId) continue;
    const access = raw.access ?? (WRITE_TYPE.test(event.type) ? 'write' : 'read'); const id = `${rooted.rootId}\u0000${rooted.path}`; const existing = touches.get(id);
    if (!existing) touches.set(id, { rootId: rooted.rootId, path: rooted.path, access }); else if (access === 'write') existing.access = 'write';
  }
  return [...touches.values()];
}
