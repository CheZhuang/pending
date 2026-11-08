import test from 'node:test';
import assert from 'node:assert/strict';
import { diffSnapshots, isNoop, lastActiveRevision, wordDiff } from './main-diff.js';

const entry = (id, body, files = [], extra = {}) => ({ id, body, files, ...extra });
const snap = (revision, entries, removedEntries = []) => ({ revision, entries, removedEntries });

test('a whole-Main restore preview lists what will be reverted, re-added and removed', () => {
  const current = snap(5, [
    entry('a', 'Tokens expire after 30 minutes'),
    entry('b', 'API errors use { error }'),
    entry('later', 'Added after revision 2'),
  ], [entry('gone', 'Use structured logs', [], { removed: true })]);
  const target = snap(2, [
    entry('a', 'Tokens expire after 15 minutes'),
    entry('b', 'API errors use { error }'),
    entry('gone', 'Use structured logs'),
  ]);
  const diff = diffSnapshots(current, target);
  const kind = (id) => diff.changes.find((c) => c.id === id).kind;
  assert.equal(kind('a'), 'reverted');
  assert.equal(kind('b'), 'unchanged');
  assert.equal(kind('gone'), 'readded');
  assert.equal(kind('later'), 'removed');
  assert.equal(diff.changes.find((c) => c.id === 'later').createdAfterTarget, true);
  assert.deepEqual(diff.summary, { reverted: 1, readded: 1, removed: 1, unchanged: 1 });
  assert.equal(diff.changes.at(-1).kind, 'unchanged', 'changes are listed before unchanged entries');
  assert.equal(isNoop(diff), false);
});

test('file reference changes alone count as a revert; identical snapshots are a no-op', () => {
  const current = snap(3, [entry('a', 'same text', [{ rootId: 'app', path: 'src/x.ts' }])]);
  const target = snap(1, [entry('a', 'same text', [])]);
  assert.equal(diffSnapshots(current, target).changes[0].kind, 'reverted');
  assert.equal(isNoop(diffSnapshots(current, current)), true);
});

test('word diff marks removed and added words and keeps shared text', () => {
  const parts = wordDiff('Tokens expire after 30 minutes', 'Tokens expire after 15 minutes');
  assert.deepEqual(parts.filter((p) => p.op !== 'same').map((p) => [p.op, p.text]), [['del', '30'], ['add', '15']]);
  assert.equal(parts.map((p) => (p.op === 'del' ? '' : p.text)).join(''), 'Tokens expire after 15 minutes');
  assert.deepEqual(wordDiff('same', 'same'), [{ op: 'same', text: 'same' }]);
});

test('a removed entry is recovered from its last active version', () => {
  assert.equal(lastActiveRevision([{ revision: 1, removed: false }, { revision: 4, removed: false }, { revision: 6, removed: true }]), 4);
  assert.equal(lastActiveRevision([{ revision: 2, removed: true }]), null);
});
