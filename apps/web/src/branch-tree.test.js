import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutBranchTree } from './branch-tree.js';

const t = (n) => `2026-11-07T10:00:0${n}.000Z`;
const overview = (id, work, sessions = []) => ({ branch: { id, name: id }, sessions, work, files: [], corrections: [], recentActivity: [] });

test('Main is the top lane and every agent branch gets its own lane below it', () => {
  const tree = layoutBranchTree({ main: { entries: [], removedEntries: [] }, branches: [overview('a', []), overview('b', [])] });
  assert.deepEqual(tree.lanes.map((l) => [l.name, l.isMain]), [['main', true], ['a', false], ['b', false]]);
  assert.ok(tree.lanes[0].y < tree.lanes[1].y && tree.lanes[1].y < tree.lanes[2].y);
});

test('nodes are placed in creation order across Main and branches', () => {
  const tree = layoutBranchTree({
    main: { entries: [{ id: 'm1', body: 'x', createdAt: t(1) }, { id: 'm2', body: 'y', createdAt: t(4), sourceWorkId: 'w1' }], removedEntries: [] },
    branches: [overview('a', [{ id: 'w1', state: 'accepted', createdAt: t(2) }]), overview('b', [{ id: 'w2', state: 'proposed', createdAt: t(3) }])],
  });
  assert.deepEqual(tree.nodes.map((n) => n.key), ['m:m1', 'w:w1', 'w:w2', 'm:m2']);
  const xs = tree.nodes.map((n) => n.x);
  assert.deepEqual(xs, [...xs].sort((p, q) => p - q));
});

test('accepted work links to the Main entry recorded from it; proposed and rejected do not', () => {
  const tree = layoutBranchTree({
    main: { entries: [{ id: 'm2', body: 'y', createdAt: t(5), sourceWorkId: 'w1' }], removedEntries: [] },
    branches: [overview('a', [
      { id: 'w1', state: 'accepted', createdAt: t(1) },
      { id: 'w2', state: 'proposed', createdAt: t(2) },
      { id: 'w3', state: 'rejected', createdAt: t(3) },
    ])],
  });
  const edge = Object.fromEntries(tree.edges.map((e) => [e.workId, e]));
  const m2 = tree.nodes.find((n) => n.key === 'm:m2');
  assert.deepEqual(edge.w1.to, { x: m2.x, y: m2.y });
  assert.equal(edge.w2.to.y, tree.mainY, 'proposed work points at a pending slot on Main');
  assert.ok(edge.w3.to.y > tree.mainY, 'rejected work stops short of Main');
});

test('accepted work whose Main entry is not visible draws no edge; removed entries stay on Main', () => {
  const tree = layoutBranchTree({
    main: { entries: [], removedEntries: [{ id: 'gone', body: 'z', createdAt: t(2), sourceWorkId: 'w9' }] },
    branches: [overview('a', [{ id: 'w1', state: 'accepted', createdAt: t(1) }, { id: 'w9', state: 'accepted', createdAt: t(0) }])],
  });
  assert.equal(tree.edges.some((e) => e.workId === 'w1'), false);
  assert.equal(tree.nodes.find((n) => n.key === 'm:gone').state, 'removed');
  assert.equal(tree.edges.find((e) => e.workId === 'w9').to.y, tree.mainY);
});

test('open conflicts are counted per branch lane', () => {
  const tree = layoutBranchTree({
    main: { entries: [], removedEntries: [] },
    branches: [overview('a', []), overview('b', [])],
    conflicts: [{ branchIds: ['a'], status: 'potential' }, { branchIds: ['a', 'b'], status: 'dismissed' }],
  });
  assert.deepEqual(tree.lanes.map((l) => l.conflicts), [0, 1, 0]);
});
