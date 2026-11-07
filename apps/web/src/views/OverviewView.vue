<!-- Overview: workspace, branches, agent sessions with declared capabilities and status, pending work. -->
<script setup>
import { computed, h } from 'vue';
import { useRouter } from 'vue-router';
import { NAlert, NButton, NCard, NDataTable, NGrid, NGridItem, NSpace, NStatistic, NTag, NTooltip, useDialog, useNotification } from 'naive-ui';
import { api } from '../api/index.js';
import { describe } from '../api/errors.js';
import { branchName, sessionLabel } from '../model.js';
import { CAPABILITY_TEXT, RUNTIME_CAPABILITIES } from '../semantics.js';
import { short } from '../format.js';
import { state, workspace } from '../state.js';
import { useData } from '../useData.js';

const router = useRouter();
const dialog = useDialog();
const notify = useNotification();

const { data, error, reload } = useData(async () => {
  const ws = workspace();
  const [branches, sessions, reviews, merges, approvals] = await Promise.all([
    api.branches(ws.id), api.sessions(), api.reviews(), api.merges(), api.approvals(),
  ]);
  const mergeIds = new Set(merges.filter((m) => m.workspaceId === ws.id).map((m) => m.id));
  return {
    ws, branches,
    sessions: sessions.filter((s) => s.workspaceId === ws.id),
    pendingReviews: reviews.filter((r) => mergeIds.has(r.mergeId) && r.state === 'pending').length,
    pendingApprovals: approvals.filter((a) => a.workspaceId === ws.id && a.state === 'pending').length,
  };
}, () => [state.workspaceId, state.changed.sessions, state.changed.reviews, state.changed.approvals, state.changed.context]);

const stats = computed(() => {
  const d = data.value;
  if (!d) return [];
  return [
    { label: 'Active sessions', value: d.sessions.filter((s) => s.state === 'active').length, suffix: `/ ${d.sessions.length}`, to: '/' },
    { label: 'Logical branches', value: d.branches.length, to: '/context' },
    { label: 'Merge reviews waiting', value: d.pendingReviews, to: '/reviews', alert: d.pendingReviews > 0 },
    { label: 'Tool approvals waiting', value: d.pendingApprovals, to: '/reviews', alert: d.pendingApprovals > 0 },
  ];
});

const stateTag = { active: 'success', 'kill-requested': 'warning', ended: 'default' };

function stop(session) {
  dialog.warning({
    title: `Stop ${sessionLabel(session)}?`,
    content: 'The gateway asks the launcher to terminate the agent process and denies its pending approvals. This is a request, not proof the process exited.',
    positiveText: 'Stop session',
    negativeText: 'Cancel',
    onPositiveClick: async () => {
      try {
        const result = await api.killSession(session.id);
        notify.success({ title: 'Stop requested', content: `State: ${result.state}, process: ${result.processStatus}`, duration: 4000 });
      } catch (e) {
        const d = describe(e);
        notify.error({ title: d.title, content: d.hint, duration: 6000 });
      } finally {
        reload();
      }
    },
  });
}

const sessionColumns = computed(() => [
  { title: 'Agent', key: 'label', render: (s) => h('div', [h('div', sessionLabel(s)), h('div', { class: 'mono muted' }, short(s.id))]) },
  { title: 'Runtime', key: 'runtime', render: (s) => h('span', { class: 'mono' }, `${s.runtime} · ${s.nativeId}`) },
  { title: 'Branch', key: 'branchId', render: (s) => branchName(data.value?.branches, s.branchId) },
  { title: 'Status', key: 'state', render: (s) => h(NTag, { size: 'small', type: stateTag[s.state] ?? 'default', round: true }, () => s.state ?? 'unknown') },
  {
    title: 'Declared capabilities', key: 'caps',
    render: (s) => {
      const caps = RUNTIME_CAPABILITIES[s.runtime];
      if (!caps) return h('span', { class: 'muted' }, 'unknown runtime');
      return h(NSpace, { size: 4 }, () => Object.entries(CAPABILITY_TEXT).map(([k, label]) =>
        h(NTag, { size: 'tiny', bordered: false, type: caps[k] ? 'info' : 'default', style: caps[k] ? '' : 'opacity:.45;text-decoration:line-through' }, () => label)));
    },
  },
  {
    title: '', key: 'actions', align: 'right',
    render: (s) => s.state === 'active'
      ? h(NButton, { size: 'small', type: 'error', secondary: true, onClick: () => stop(s) }, () => 'Stop')
      : null,
  },
]);

const branchColumns = computed(() => [
  { title: 'Branch', key: 'name', render: (b) => h('span', { style: 'font-weight:500' }, b.name) },
  { title: 'Revision', key: 'revision' },
  { title: 'Sessions', key: 'sessions', render: (b) => data.value.sessions.filter((s) => s.branchId === b.id).map(sessionLabel).join(', ') || '—' },
  {
    title: 'Rules', key: 'flags',
    render: (b) => b.id === data.value.ws.mainBranchId
      ? h(NTag, { size: 'small', type: 'success', bordered: false }, () => 'main · human-reviewed merges only')
      : b.restricted ? h(NTag, { size: 'small', type: 'warning', bordered: false }, () => 'restricted') : h('span', { class: 'muted' }, 'agent branch · inherits main'),
  },
]);
</script>

<template>
  <div class="page">
    <h1 class="page-title">{{ data?.ws.name ?? 'Overview' }}</h1>
    <p class="page-sub">
      <template v-if="data">
        <span v-for="r in data.ws.roots" :key="r.id" class="mono" style="margin-right: 14px">{{ r.id }} = {{ r.path }}</span>
        <span class="mono muted">workspace {{ short(data.ws.id) }}</span>
      </template>
    </p>
    <NAlert v-if="error" type="error" :title="describe(error).title" style="margin-bottom: 16px">{{ describe(error).hint }}</NAlert>

    <NGrid cols="1 s:2 l:4" responsive="screen" :x-gap="14" :y-gap="14" style="margin-bottom: 16px">
      <NGridItem v-for="s in stats" :key="s.label">
        <NCard size="small" hoverable class="stat" :class="{ alert: s.alert }" @click="router.push(s.to)">
          <NStatistic :label="s.label" :value="s.value">
            <template v-if="s.suffix" #suffix><span class="muted" style="font-size: 14px">{{ s.suffix }}</span></template>
          </NStatistic>
        </NCard>
      </NGridItem>
    </NGrid>

    <NCard title="Agent sessions" size="small" style="margin-bottom: 16px">
      <template #header-extra>
        <NTooltip>
          <template #trigger><span class="muted" style="font-size: 12px">capabilities: declared by adapters</span></template>
          The gateway does not report capabilities. These come from the adapter docs: Claude Code supports a pre-execution hook; Codex is observed through the App Server but its tools are not intercepted.
        </NTooltip>
      </template>
      <NDataTable :columns="sessionColumns" :data="data?.sessions ?? []" :bordered="false" size="small" :scroll-x="900" :row-key="(s) => s.id" />
    </NCard>

    <NCard title="Logical branches" size="small">
      <template #header-extra><span class="muted" style="font-size: 12px">independent of Git branches</span></template>
      <NDataTable :columns="branchColumns" :data="data?.branches ?? []" :bordered="false" size="small" :scroll-x="640" :row-key="(b) => b.id" />
    </NCard>
  </div>
</template>

<style scoped>
.stat { cursor: pointer; }
.stat.alert { border-color: #e5c89088; }
.stat.alert :deep(.n-statistic-value__content) { color: #e5c890; }
</style>
