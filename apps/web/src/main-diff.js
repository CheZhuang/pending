// Compares two Main snapshots for review only: what restoring `target` would
// change in `current`. The Gateway performs the restore; this never builds or
// edits authoritative history locally.

const fileKey = (f) => `${f.rootId}:${f.path}`;
const sameFiles = (a = [], b = []) => a.map(fileKey).sort().join('\n') === b.map(fileKey).sort().join('\n');

/** All entries of a snapshot (active and removed) by id. */
function byId(snapshot) {
  const map = new Map();
  for (const e of snapshot?.removedEntries ?? []) map.set(e.id, { ...e, removed: true });
  for (const e of snapshot?.entries ?? []) map.set(e.id, { ...e, removed: false });
  return map;
}

/**
 * Per entry, what a whole-Main restore to `target` does to `current`:
 * - reverted:  active in both, text or files differ (current → target)
 * - readded:   active in target, removed in current
 * - removed:   active in current, removed at target or created after it
 * - unchanged: same active content, or inactive on both sides
 */
export function diffSnapshots(current, target) {
  const now = byId(current);
  const then = byId(target);
  const changes = [];
  for (const id of new Set([...now.keys(), ...then.keys()])) {
    const before = now.get(id);
    const after = then.get(id);
    const activeBefore = !!before && !before.removed;
    const activeAfter = !!after && !after.removed;
    let kind = 'unchanged';
    if (activeBefore && activeAfter) kind = before.body === after.body && sameFiles(before.files, after.files) ? 'unchanged' : 'reverted';
    else if (activeAfter) kind = 'readded';
    else if (activeBefore) kind = 'removed';
    changes.push({ id, kind, current: before ?? null, target: after ?? null, createdAfterTarget: !after });
  }
  const order = { reverted: 0, readded: 1, removed: 2, unchanged: 3 };
  changes.sort((a, b) => order[a.kind] - order[b.kind]);
  const count = (k) => changes.filter((c) => c.kind === k).length;
  return { changes, summary: { reverted: count('reverted'), readded: count('readded'), removed: count('removed'), unchanged: count('unchanged') } };
}

/** True when restoring would change nothing visible (the Gateway still records a new revision). */
export const isNoop = (diff) => diff.summary.reverted + diff.summary.readded + diff.summary.removed === 0;

/**
 * Word-level diff for short Main bodies: [{op:'same'|'add'|'del', text}].
 * Falls back to a whole replacement for very long texts to stay cheap.
 */
export function wordDiff(before = '', after = '') {
  if (before === after) return [{ op: 'same', text: before }];
  const a = before.split(/(\s+)/).filter((t) => t !== '');
  const b = after.split(/(\s+)/).filter((t) => t !== '');
  if (a.length * b.length > 250_000) return [{ op: 'del', text: before }, { op: 'add', text: after }];
  const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const out = [];
  const push = (op, text) => { const last = out.at(-1); if (last?.op === op) last.text += text; else out.push({ op, text }); };
  let i = 0; let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { push('same', a[i]); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) push('del', a[i++]);
    else push('add', b[j++]);
  }
  while (i < a.length) push('del', a[i++]);
  while (j < b.length) push('add', b[j++]);
  return out;
}

/** Global revision of an entry's last active version: what to restore to recover a removed entry. */
export function lastActiveRevision(entryHistory = []) {
  return [...entryHistory].reverse().find((v) => !v.removed)?.revision ?? null;
}
