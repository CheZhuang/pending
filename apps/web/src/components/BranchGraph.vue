<!-- Branch tree as a small hand-drawn SVG (no chart library).
     Lanes: main on top, one lane per agent branch (each inherits main).
     Nodes: commits on the branch that authored them; circles = findings, diamonds = decisions,
     colored by sync authority. Main shows the human-reviewed attachments.
     Edges: solid = applied merge, dashed = merge waiting for review, red ✕ = rejected. -->
<script setup>
import { computed } from 'vue';
import { authorityColor, frappe } from '../theme.js';
import { labelSnapshot } from '../semantics.js';
import { clip, scopeText } from '../format.js';
import { sessionLabel } from '../model.js';

const props = defineProps({
  model: { type: Object, required: true },
  selectedId: { type: String, default: null },
});
const emit = defineEmits(['select']);

const LABEL_W = 170;
const LANE_H = 64;
const TOP = 34;
const COL_W = 74;

const layout = computed(() => {
  const { branches, snapshots, merges, sessions, workspace } = props.model;
  const mainId = workspace.mainBranchId;
  const lanes = [...branches].sort((a, b) => (a.id === mainId ? -1 : b.id === mainId ? 1 : 0));
  const laneY = new Map(lanes.map((b, i) => [b.id, TOP + i * LANE_H + 26]));

  // Every visible commit once, ordered by creation: one column each.
  const all = new Map();
  for (const s of Object.values(snapshots)) for (const c of s.history) all.set(c.id, c);
  // Ties (same millisecond) fall back to the author branch's own revision, then id, so order is stable.
  const ordered = [...all.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.revision - b.revision || a.id.localeCompare(b.id));
  const x0 = LABEL_W + 40;
  const colX = new Map(ordered.map((c, i) => [c.id, x0 + i * COL_W]));

  // Authority of drafts on their own lane, and of attachments on main.
  const draftAuthority = new Map();
  for (const b of lanes) {
    if (b.id === mainId) continue;
    for (const e of labelSnapshot(snapshots[b.id], mainId)) if (e.branchId === b.id) draftAuthority.set(e.commit.id, e.authority);
  }
  const mainEntries = labelSnapshot(snapshots[mainId], mainId);

  const nodes = [];
  for (const c of ordered) {
    const y = laneY.get(c.branchId);
    if (y === undefined) continue;
    const authority = draftAuthority.get(c.id) ?? (c.knowledge.kind === 'decision' ? 'proposed-decision' : 'finding');
    nodes.push({ key: `d:${c.id}`, commit: c, x: colX.get(c.id), y, authority, onMain: false });
  }

  // Main attachments sit just after their source commit, in attachment order.
  const mainY = laneY.get(mainId);
  const mainX = new Map();
  let lastX = x0 - COL_W;
  for (const e of mainEntries) {
    const x = Math.max((colX.get(e.commit.id) ?? lastX) + COL_W * 0.55, lastX + COL_W * 0.55);
    lastX = x;
    mainX.set(e.commit.id, x);
    nodes.push({ key: `m:${e.commit.id}`, commit: e.commit, x, y: mainY, authority: e.authority, onMain: true });
  }

  const edges = [];
  for (const m of merges) {
    const targetY = laneY.get(m.targetBranchId);
    for (const id of m.commitIds) {
      const c = all.get(id);
      if (!c || targetY === undefined) continue;
      const from = { x: colX.get(id), y: laneY.get(c.branchId) };
      if (from.y === undefined) continue;
      const to = m.state === 'applied' && m.targetBranchId === mainId && mainX.has(id)
        ? { x: mainX.get(id), y: targetY }
        : { x: from.x + COL_W * 0.55, y: targetY };
      edges.push({ key: `${m.id}:${id}`, from, to, state: m.state });
    }
  }

  const width = Math.max(x0 + Math.max(ordered.length, 1) * COL_W, lastX + COL_W) + 30;
  const height = TOP + lanes.length * LANE_H + 6;
  const laneInfo = lanes.map((b) => ({
    branch: b,
    y: laneY.get(b.id),
    isMain: b.id === mainId,
    sessions: sessions.filter((s) => s.branchId === b.id).map(sessionLabel).join(', '),
  }));
  return { lanes: laneInfo, nodes, edges, width, height, x0, mainY };
});

const curve = (a, b) => {
  const midY = (a.y + b.y) / 2;
  return `M ${a.x} ${a.y} C ${a.x} ${midY}, ${b.x} ${midY}, ${b.x} ${b.y}`;
};
const diamond = (x, y, r) => `M ${x} ${y - r} L ${x + r} ${y} L ${x} ${y + r} L ${x - r} ${y} Z`;
// A shadowed draft is still a proposal (drawn dimmed), not a rejected one.
const color = (authority) => authorityColor[authority === 'shadowed' ? 'proposed-decision' : authority] ?? frappe.overlay1;
const tip = (n) => `${n.commit.knowledge.kind} "${n.commit.knowledge.key}" · ${n.authority}\n@ ${scopeText(n.commit.knowledge.scope)}\n${clip(n.commit.knowledge.body, 140)}`;
</script>

<template>
  <div class="graph-wrap">
    <svg :width="layout.width" :height="layout.height" :viewBox="`0 0 ${layout.width} ${layout.height}`" role="img" aria-label="Branch tree">
      <!-- lanes -->
      <g v-for="lane in layout.lanes" :key="lane.branch.id">
        <rect x="0" :y="lane.y - LANE_H / 2 + 4" :width="layout.width" :height="LANE_H - 8" rx="6" :fill="lane.isMain ? '#a6d18910' : 'transparent'" />
        <text x="14" :y="lane.y - 3" class="lane-name" :fill="lane.isMain ? frappe.green : frappe.text">{{ lane.branch.name }}</text>
        <text x="14" :y="lane.y + 13" class="lane-sub">
          <title>{{ lane.sessions }}</title>
          {{ lane.isMain ? 'shared · human-reviewed' : clip(lane.sessions || 'no session', 24) }}
        </text>
        <line :x1="lane.isMain ? LABEL_W : LABEL_W + 24" :y1="lane.y" :x2="layout.width - 16" :y2="lane.y" :stroke="lane.isMain ? frappe.green : frappe.surface2" :stroke-width="lane.isMain ? 2.5 : 1.5" stroke-linecap="round" />
        <!-- inheritance: every agent branch forks from main -->
        <path v-if="!lane.isMain" :d="curve({ x: LABEL_W, y: layout.mainY }, { x: LABEL_W + 24, y: lane.y })" fill="none" :stroke="frappe.surface2" stroke-width="1.5" />
      </g>

      <!-- merges -->
      <g v-for="e in layout.edges" :key="e.key">
        <path :d="curve(e.from, e.to)" fill="none"
          :stroke="e.state === 'applied' ? frappe.green : e.state === 'rejected' ? frappe.red : frappe.yellow"
          :stroke-width="e.state === 'applied' ? 2 : 1.6" :stroke-dasharray="e.state === 'applied' ? '' : '5 4'" opacity="0.85" />
        <template v-if="e.state === 'pending'">
          <circle :cx="e.to.x" :cy="e.to.y" r="7" :fill="frappe.base" :stroke="frappe.yellow" stroke-width="1.8" stroke-dasharray="3 2" />
          <text :x="e.to.x" :y="e.to.y - 12" class="edge-label" :fill="frappe.yellow">review</text>
        </template>
        <text v-if="e.state === 'rejected'" :x="e.to.x" :y="e.to.y + 4" class="edge-x" :fill="frappe.red">✕</text>
      </g>

      <!-- commits -->
      <g v-for="n in layout.nodes" :key="n.key" class="node" :class="{ selected: n.commit.id === selectedId }" @click="emit('select', n.commit.id)">
        <title>{{ tip(n) }}</title>
        <circle v-if="n.commit.id === selectedId" :cx="n.x" :cy="n.y" r="13" fill="none" :stroke="frappe.lavender" stroke-width="2" />
        <circle v-if="n.commit.knowledge.kind === 'finding'" :cx="n.x" :cy="n.y" r="7.5" :fill="color(n.authority)" :stroke="frappe.crust" stroke-width="2"
          :opacity="n.authority === 'superseded-decision' ? 0.55 : 1" />
        <path v-else :d="diamond(n.x, n.y, 9.5)" :fill="color(n.authority)" :stroke="frappe.crust" stroke-width="2"
          :opacity="n.authority === 'superseded-decision' || n.authority === 'shadowed' ? 0.55 : 1" />
        <line v-if="n.authority === 'superseded-decision'" :x1="n.x - 9" :y1="n.y + 9" :x2="n.x + 9" :y2="n.y - 9" :stroke="frappe.red" stroke-width="1.8" />
        <text :x="n.x" :y="n.y + 24" class="node-label">{{ clip(n.commit.knowledge.key, 12) }}</text>
      </g>
    </svg>
  </div>
</template>

<style scoped>
.graph-wrap { overflow-x: auto; overflow-y: hidden; padding-bottom: 4px; }
svg { display: block; }
.lane-name { font-size: 13px; font-weight: 600; }
.lane-sub { font-size: 11px; fill: #a5adce; }
.node { cursor: pointer; }
.node:hover circle, .node:hover path { filter: brightness(1.2); }
.node-label { font-size: 10.5px; fill: #a5adce; text-anchor: middle; font-family: ui-monospace, Menlo, monospace; }
.edge-label { font-size: 10px; text-anchor: middle; }
.edge-x { font-size: 13px; text-anchor: middle; font-weight: 700; }
</style>
