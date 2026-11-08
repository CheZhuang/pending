<!-- Branch tree as a small hand-drawn SVG (no chart library).
     Lanes: Main on top, one lane per agent branch (each forks from Main).
     Nodes: diamonds = Main entries, circles = work proposals colored by state.
     Edges: solid green = accepted into Main, dashed yellow = waiting for review, red ✕ = rejected. -->
<script setup>
import { computed } from 'vue';
import { frappe } from '../theme.js';
import { clip, dateTime, short } from '../format.js';
import { LABEL_W, LANE_H, curve, layoutBranchTree } from '../branch-tree.js';

const props = defineProps({
  context: { type: Object, required: true },
  selectedBranchId: { type: String, default: null },
  selectedWorkId: { type: String, default: null },
});
const emit = defineEmits(['select']);

const layout = computed(() => layoutBranchTree(props.context));
const stateColor = { main: frappe.green, removed: frappe.overlay0, proposed: frappe.yellow, accepted: frappe.green, rejected: frappe.red };
const edgeColor = { accepted: frappe.green, proposed: frappe.yellow, rejected: frappe.red };
const diamond = (x, y, r) => `M ${x} ${y - r} L ${x + r} ${y} L ${x} ${y + r} L ${x - r} ${y} Z`;
const files = (list) => (list ?? []).map((f) => `${f.rootId}:${f.path}`).join(', ');
const tip = (n) => n.kind === 'main'
  ? `Main entry · revision ${n.entry.revision}${n.entry.removed ? ' · removed' : ''}\n${clip(n.entry.body, 160)}${n.entry.files?.length ? `\n${files(n.entry.files)}` : ''}\n${dateTime(n.entry.createdAt)}`
  : `${n.work.intent || 'Work proposal'} · ${n.state}\n${clip(n.work.body, 160)}${n.work.files?.length ? `\n${files(n.work.files)}` : ''}\n${dateTime(n.work.createdAt)} · session ${short(n.work.sessionId)}`;
const label = (n) => clip(n.kind === 'main' ? `r${n.entry.revision}` : n.work.intent || short(n.work.id), 12);
const select = (branchId, workId = null) => { if (branchId) emit('select', { branchId, workId }); };
</script>

<template>
  <div class="graph-wrap">
    <svg :width="layout.width" :height="layout.height" :viewBox="`0 0 ${layout.width} ${layout.height}`" role="img" aria-label="Branch tree">
      <!-- lanes -->
      <g v-for="lane in layout.lanes" :key="lane.id ?? 'main'" :class="{ lane: !lane.isMain }" @click="select(lane.id)">
        <rect x="0" :y="lane.y - LANE_H / 2 + 4" :width="layout.width" :height="LANE_H - 8" rx="6"
          :fill="lane.isMain ? '#a6d18910' : lane.id === selectedBranchId ? '#babbf114' : 'transparent'" />
        <text x="14" :y="lane.y - 3" class="lane-name" :fill="lane.isMain ? frappe.green : lane.id === selectedBranchId ? frappe.lavender : frappe.text">
          {{ clip(lane.name, 18) }}<tspan v-if="lane.conflicts" :fill="frappe.peach" dx="6">⚠ {{ lane.conflicts }}</tspan>
          <title>{{ lane.name }}{{ lane.conflicts ? ` · ${lane.conflicts} open conflict${lane.conflicts > 1 ? 's' : ''}` : '' }}</title>
        </text>
        <text x="14" :y="lane.y + 13" class="lane-sub">
          <title>{{ lane.sessions }}</title>
          {{ clip(lane.sessions || 'no session', 24) }}
        </text>
        <line :x1="lane.isMain ? LABEL_W : LABEL_W + 24" :y1="lane.y" :x2="layout.width - 16" :y2="lane.y"
          :stroke="lane.isMain ? frappe.green : frappe.surface2" :stroke-width="lane.isMain ? 2.5 : 1.5" stroke-linecap="round" />
        <!-- every agent branch forks from Main -->
        <path v-if="!lane.isMain" :d="curve({ x: LABEL_W, y: layout.mainY }, { x: LABEL_W + 24, y: lane.y })" fill="none" :stroke="frappe.surface2" stroke-width="1.5" />
      </g>

      <!-- merges -->
      <g v-for="e in layout.edges" :key="e.key">
        <path :d="curve(e.from, e.to)" fill="none" :stroke="edgeColor[e.state]"
          :stroke-width="e.state === 'accepted' ? 2 : 1.6" :stroke-dasharray="e.state === 'accepted' ? '' : '5 4'" opacity="0.85" />
        <template v-if="e.state === 'proposed'">
          <circle :cx="e.to.x" :cy="e.to.y" r="7" :fill="frappe.base" :stroke="frappe.yellow" stroke-width="1.8" stroke-dasharray="3 2" />
          <text :x="e.to.x" :y="e.to.y - 12" class="edge-label" :fill="frappe.yellow">review</text>
        </template>
        <text v-if="e.state === 'rejected'" :x="e.to.x" :y="e.to.y + 4" class="edge-x" :fill="frappe.red">✕</text>
      </g>

      <!-- nodes -->
      <g v-for="n in layout.nodes" :key="n.key" class="node" :class="{ clickable: n.kind === 'work' }" @click.stop="n.kind === 'work' && select(n.branchId, n.work.id)">
        <title>{{ tip(n) }}</title>
        <circle v-if="n.kind === 'work' && n.work.id === selectedWorkId" :cx="n.x" :cy="n.y" r="13" fill="none" :stroke="frappe.lavender" stroke-width="2" />
        <path v-if="n.kind === 'main'" :d="diamond(n.x, n.y, 9)" :fill="n.state === 'removed' ? frappe.base : stateColor.main"
          :stroke="n.state === 'removed' ? stateColor.removed : frappe.crust" stroke-width="2" />
        <circle v-else :cx="n.x" :cy="n.y" r="7.5" :fill="stateColor[n.state] ?? frappe.overlay1" :stroke="frappe.crust" stroke-width="2"
          :opacity="n.state === 'rejected' ? 0.6 : 1" />
        <text :x="n.x" :y="n.y + 24" class="node-label">{{ label(n) }}</text>
      </g>
    </svg>
    <div class="legend muted">
      <span><svg width="14" height="14"><path :d="diamond(7, 7, 6)" :fill="frappe.green" /></svg> Main entry</span>
      <span><svg width="14" height="14"><circle cx="7" cy="7" r="5" :fill="frappe.yellow" /></svg> proposed</span>
      <span><svg width="14" height="14"><circle cx="7" cy="7" r="5" :fill="frappe.green" /></svg> accepted</span>
      <span><svg width="14" height="14"><circle cx="7" cy="7" r="5" :fill="frappe.red" opacity="0.6" /></svg> rejected</span>
      <span>Click a branch or proposal to open it below.</span>
    </div>
  </div>
</template>

<style scoped>
.graph-wrap { overflow-x: auto; overflow-y: hidden; padding-bottom: 4px; }
svg { display: block; }
.lane { cursor: pointer; }
.lane-name { font-size: 13px; font-weight: 600; }
.lane-sub { font-size: 11px; fill: #a5adce; }
.node.clickable { cursor: pointer; }
.node:hover circle, .node:hover path { filter: brightness(1.2); }
.node-label { font-size: 10.5px; fill: #a5adce; text-anchor: middle; font-family: ui-monospace, Menlo, monospace; }
.edge-label { font-size: 10px; text-anchor: middle; }
.edge-x { font-size: 13px; text-anchor: middle; font-weight: 700; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 11.5px; margin-top: 6px; }
.legend span { display: inline-flex; align-items: center; gap: 5px; }
.legend svg { display: inline-block; }
</style>
