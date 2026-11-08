// Layout for the Branches tree: Main on top, one lane per agent branch forking from it.
// Built only from the SupervisionContext (Main snapshot + branch work), so it works
// the same against the mock and the live Gateway.
//
// Nodes: Main entries on the Main lane, work proposals on their branch lane, one
// column each in creation order. Edges: accepted work → the Main entry that records
// it (via sourceWorkId); proposed work → a pending review slot on Main; rejected
// work → a stub that stops short of Main.

export const LABEL_W = 170;
export const LANE_H = 64;
export const TOP = 18;
export const COL_W = 74;

const byTime = (a, b) => String(a.createdAt).localeCompare(String(b.createdAt));

/**
 * @param {{ main: { entries: any[], removedEntries?: any[] }, branches: any[], conflicts?: any[] }} context
 * @param {string} [mainName]
 */
export function layoutBranchTree(context, mainName = 'main') {
  const overviews = context?.branches ?? [];
  const entries = [
    ...(context?.main?.entries ?? []).map((e) => ({ ...e, removed: false })),
    ...(context?.main?.removedEntries ?? []).map((e) => ({ ...e, removed: true })),
  ];
  const lanes = [
    { id: null, name: mainName, isMain: true, sessions: 'shared · human-reviewed', conflicts: 0 },
    ...overviews.map((o) => ({
      id: o.branch.id,
      name: o.branch.name,
      isMain: false,
      sessions: o.sessions.map((s) => s.label || s.runtime).join(', '),
      conflicts: (context?.conflicts ?? []).filter((c) => c.branchIds?.includes(o.branch.id) && (c.status === 'potential' || c.status === 'confirmed')).length,
    })),
  ];
  lanes.forEach((lane, i) => { lane.y = TOP + i * LANE_H + LANE_H / 2; });
  const laneY = new Map(lanes.map((l) => [l.id, l.y]));
  const mainY = lanes[0].y;

  // One column per item in creation order; Array.prototype.sort is stable, so ties keep Main first.
  const items = [
    ...entries.map((entry) => ({ kind: 'main', entry, createdAt: entry.createdAt })),
    ...overviews.flatMap((o) => o.work.map((work) => ({ kind: 'work', work, branchId: o.branch.id, createdAt: work.createdAt }))),
  ].sort(byTime);
  const x0 = LABEL_W + 44;
  const nodes = items.map((item, i) => item.kind === 'main'
    ? { key: `m:${item.entry.id}`, kind: 'main', entry: item.entry, x: x0 + i * COL_W, y: mainY, state: item.entry.removed ? 'removed' : 'main' }
    : { key: `w:${item.work.id}`, kind: 'work', work: item.work, branchId: item.branchId, x: x0 + i * COL_W, y: laneY.get(item.branchId), state: item.work.state });

  const mainBySource = new Map(nodes.filter((n) => n.kind === 'main' && n.entry.sourceWorkId).map((n) => [n.entry.sourceWorkId, n]));
  const edges = [];
  for (const n of nodes) {
    if (n.kind !== 'work') continue;
    const target = n.state === 'accepted' ? mainBySource.get(n.work.id) : undefined;
    if (n.state === 'accepted' && !target) continue; // Main entry not visible (e.g. history pruned): no edge to draw.
    const to = target ? { x: target.x, y: target.y } : { x: n.x + COL_W * 0.5, y: n.state === 'rejected' ? (n.y + mainY) / 2 : mainY };
    edges.push({ key: `e:${n.work.id}`, from: { x: n.x, y: n.y }, to, state: n.state, branchId: n.branchId, workId: n.work.id });
  }

  const width = x0 + Math.max(items.length, 1) * COL_W + 20;
  const height = TOP + lanes.length * LANE_H;
  return { lanes, nodes, edges, width, height, mainY, x0 };
}

/** Cubic curve between two points, bending vertically. */
export function curve(a, b) {
  const midY = (a.y + b.y) / 2;
  return `M ${a.x} ${a.y} C ${a.x} ${midY}, ${b.x} ${midY}, ${b.x} ${b.y}`;
}
