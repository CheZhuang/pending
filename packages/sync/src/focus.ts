// Best-effort working focus for one session, derived from explicit scope
// declarations and recent observed file activity. Focus only influences
// relevance ranking; observed activity never grants permissions.
import type { NormalizedEvent, Scope, WorkspaceRoot } from '../../contracts/src/index.js';
import { normalizeScope } from '../../core/src/scope.js';
import { parentFolder, toRootedPath } from './paths.js';

export type Access = 'read' | 'write';

/** One file an event says the agent read or wrote, already root-relative. */
export interface Touch {
  path: string;
  rootId?: string;
  access: Access;
}

export type FocusSource = 'declared' | 'modified' | 'read' | 'folder' | 'root';

export interface FocusEntry {
  scope: Scope;
  source: FocusSource;
  /** 0..1, higher = more central to what the session is doing now. */
  weight: number;
}

export interface Focus {
  sessionId: string;
  entries: FocusEntry[];
}

/** Explicit subscriptions: `extend` adds to inferred focus, `override` replaces it. */
export interface FocusDeclaration {
  scopes: Scope[];
  mode?: 'extend' | 'override';
}

export interface FocusOptions {
  /** How many distinct recent files to keep (default 20). */
  maxFiles?: number;
}

export const BASE_WEIGHT: Record<FocusSource, number> = {
  declared: 1,
  modified: 0.9,
  read: 0.6,
  folder: 0.4,
  root: 0.2,
};

const WRITE_TOOLS = /^(edit|write|multiedit|notebookedit|apply_patch)$/i;
const READ_TOOLS = /^(read|grep|glob|ls|notebookread)$/i;
const WRITE_TYPE = /(write|edit|patch|change|create|delete|modif)/i;

type Raw = { path: string; rootId?: string; access?: Access };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}
const str = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : undefined);

/**
 * Pull file paths out of a normalized event payload. Supported shapes:
 * - `payload.touches: [{ path, rootId?, access }]`  (preferred adapter contract)
 * - Claude Code hooks/JSONL: `tool_name` + `tool_input.file_path | notebook_path | path`
 * - B's normalized tool records: `tool` + `input.file_path | notebook_path | path`
 * - Codex file changes: `changes`, `item.changes`, or App Server `params.item.changes: [{ path }]`
 */
function rawPaths(event: NormalizedEvent): { cwd?: string; paths: Raw[] } {
  const payload = record(event.payload) ?? {};
  const params = record(payload.params);
  const cwd = str(payload.cwd) ?? str(params?.cwd);
  const paths: Raw[] = [];

  if (Array.isArray(payload.touches)) {
    for (const t of payload.touches.map(record)) {
      const path = str(t?.path);
      if (path) paths.push({ path, rootId: str(t?.rootId), access: t?.access === 'write' ? 'write' : 'read' });
    }
  }

  const input = record(payload.tool_input) ?? record(payload.input);
  const toolPath = str(input?.file_path) ?? str(input?.notebook_path) ?? str(input?.path);
  if (toolPath) {
    const tool = str(payload.tool_name) ?? str(payload.tool) ?? '';
    paths.push({ path: toolPath, access: WRITE_TOOLS.test(tool) ? 'write' : READ_TOOLS.test(tool) ? 'read' : undefined });
  }

  for (const changes of [payload.changes, record(payload.item)?.changes, record(params?.item)?.changes]) {
    if (!Array.isArray(changes)) continue;
    for (const change of changes.map(record)) {
      const path = str(change?.path);
      if (path) paths.push({ path, access: 'write' });
    }
  }
  return { cwd, paths };
}

/** Root-relative file touches for one event; paths outside the workspace are dropped. */
export function extractTouches(event: NormalizedEvent, roots: WorkspaceRoot[]): Touch[] {
  const { cwd, paths } = rawPaths(event);
  const touches: Touch[] = [];
  for (const raw of paths) {
    // An adapter-supplied rootId narrows resolution to that root; unknown roots are dropped.
    const candidates = raw.rootId ? roots.filter((r) => r.id === raw.rootId) : roots;
    if (raw.rootId && candidates.length === 0) continue;
    const rooted = toRootedPath(raw.path, candidates, cwd);
    if (!rooted) continue;
    const access = raw.access ?? (WRITE_TYPE.test(event.type) ? 'write' : 'read');
    touches.push({ ...rooted, access });
  }
  return touches;
}

const key = (rootId: string | undefined, path: string) => `${rootId ?? ''}\u0000${path}`;
const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Derive focus from a session's events (oldest → newest, e.g. an EventPage).
 * Events from other sessions are ignored. The newest file gets full weight;
 * older files decay linearly to half weight. Writes outrank reads.
 */
export function deriveFocus(input: {
  sessionId: string;
  events: NormalizedEvent[];
  roots: WorkspaceRoot[];
  declaration?: FocusDeclaration;
  options?: FocusOptions;
}): Focus {
  const { sessionId, events, roots, declaration } = input;
  const maxFiles = input.options?.maxFiles ?? 20;
  const declared: FocusEntry[] = (declaration?.scopes ?? []).map((scope) => ({
    scope: normalizeScope(scope, roots),
    source: 'declared',
    weight: BASE_WEIGHT.declared,
  }));
  if (declaration?.mode === 'override') return { sessionId, entries: declared };

  // Walk newest → oldest so the first sighting of a file is its most recent one.
  const files = new Map<string, Touch>();
  for (let i = events.length - 1; i >= 0 && files.size < maxFiles; i--) {
    if (events[i].sessionId !== sessionId) continue;
    for (const touch of extractTouches(events[i], roots).reverse()) {
      const k = key(touch.rootId, touch.path);
      const seen = files.get(k);
      if (!seen) files.set(k, touch);
      else if (touch.access === 'write') seen.access = 'write'; // any write marks it modified
      if (files.size >= maxFiles) break;
    }
  }

  const entries: FocusEntry[] = [...declared];
  const folders = new Map<string, FocusEntry>();
  const rootsSeen = new Map<string, FocusEntry>();
  const ordered = [...files.values()];
  ordered.forEach((touch, rank) => {
    const decay = ordered.length <= 1 ? 1 : 1 - (0.5 * rank) / (ordered.length - 1);
    const source: FocusSource = touch.access === 'write' ? 'modified' : 'read';
    const rootId = touch.rootId === undefined ? {} : { rootId: touch.rootId };
    entries.push({ scope: { type: 'file', path: touch.path, ...rootId }, source, weight: round(BASE_WEIGHT[source] * decay) });

    // Modified files pull in their folder, so sibling-level knowledge is relevant.
    const folder = parentFolder(touch.path);
    if (source === 'modified' && folder !== '.') {
      const k = key(touch.rootId, folder);
      if (!folders.has(k)) folders.set(k, { scope: { type: 'folder', path: folder, ...rootId }, source: 'folder', weight: round(BASE_WEIGHT.folder * decay) });
    }
    // Any activity in a root associates the session with that root.
    const rk = touch.rootId ?? '';
    if (!rootsSeen.has(rk)) rootsSeen.set(rk, { scope: { type: 'folder', path: '.', ...rootId }, source: 'root', weight: BASE_WEIGHT.root });
  });

  return { sessionId, entries: [...entries, ...folders.values(), ...rootsSeen.values()] };
}
