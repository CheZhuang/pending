<script setup>
import { computed, h } from 'vue';
import { NAlert, NButton, NCard, NDataTable, NGrid, NGridItem, NStatistic, NTag, useDialog, useNotification } from 'naive-ui';
import { api } from '../api/index.js';
import { describe } from '../api/errors.js';
import { state, workspace } from '../state.js';
import { useData } from '../useData.js';
import { short } from '../format.js';
import { sessionLabel } from '../model.js';

const dialog = useDialog(); const notify = useNotification();
const CAPABILITIES = {
  'claude-code': ['Observe native activity', 'Managed session', 'Pre-execution hook'],
  claude: ['Observe native activity', 'Managed session', 'Pre-execution hook'],
  codex: ['Observe App Server events', 'Managed session', 'Selected native approval callbacks; no universal interception'],
};
const { data, error, reload } = useData(async () => {
  const ws = workspace();
  const [branches, sessions] = await Promise.all([api.branches(ws.id), api.sessions()]);
  return { ws, branches, sessions: sessions.filter(s => s.workspaceId === ws.id) };
}, () => [state.workspaceId, state.changed.sessions, state.changed.context]);
const stats = computed(() => [
  { label: 'Active sessions', value: data.value?.sessions.filter(s => s.state === 'active').length ?? 0 },
  { label: 'Logical branches', value: data.value?.branches.length ?? 0 },
]);
const columns = computed(() => [
  { title: 'Agent', key: 'label', render: s => `${sessionLabel(s)} · ${short(s.id)}` },
  { title: 'Runtime', key: 'runtime', render: s => h('span', { class: 'mono' }, `${s.runtime} · ${s.nativeId}`) },
  { title: 'Branch', key: 'branchId', render: s => data.value?.branches.find(b => b.id === s.branchId)?.name ?? short(s.branchId) },
  { title: 'Lifecycle', key: 'state', render: s => h(NTag, { size:'small', bordered:false, type:s.state === 'active' ? 'success' : s.state === 'kill-requested' ? 'warning' : 'default' }, () => `${s.state ?? 'unknown'} · ${s.processStatus ?? 'unknown process'}`) },
  { title: 'Declared adapter capabilities', key: 'caps', render: s => (CAPABILITIES[s.runtime] ?? ['Unknown runtime']).join(' · ') },
  { title: '', key: 'action', align:'right', render: s => s.state === 'active' ? h(NButton, { size:'small', type:'error', secondary:true, onClick:() => stop(s) }, () => 'Stop') : null },
]);
function stop(session) {
  dialog.warning({ title:`Stop ${sessionLabel(session)}?`, content:'This requests termination through the launcher. Exit status is shown only after the launcher reports it.', positiveText:'Stop session', negativeText:'Cancel', onPositiveClick:async () => {
    try { const result = await api.killSession(session.id); notify.success({ title:'Stop requested', content:`${result.state} · process ${result.processStatus}` }); }
    catch (e) { const d = describe(e); notify.error({ title:d.title, content:d.hint }); }
    finally { reload(); }
  } });
}
</script>

<template>
  <div class="page">
    <h1 class="page-title">{{ data?.ws.name ?? 'Overview' }}</h1>
    <p class="page-sub">Workspace sessions and adapter-reported capabilities. Capability descriptions are declared by the integration, not measured by the Gateway.</p>
    <NAlert v-if="error" type="error" :title="describe(error).title">{{ describe(error).hint }}</NAlert>
    <NGrid cols="1 s:2" responsive="screen" :x-gap="14" style="margin-bottom:14px"><NGridItem v-for="item in stats" :key="item.label"><NCard size="small"><NStatistic :label="item.label" :value="item.value" /></NCard></NGridItem></NGrid>
    <NCard title="Agent sessions" size="small" style="margin-bottom:14px"><NDataTable :columns="columns" :data="data?.sessions ?? []" :bordered="false" size="small" :scroll-x="1000" :row-key="s => s.id" /></NCard>
    <NCard title="Logical branches" size="small"><div v-for="branch in data?.branches ?? []" :key="branch.id" class="branch-line"><strong>{{ branch.name }}</strong><span class="muted">revision {{ branch.revision }}</span><span class="muted">{{ data.sessions.filter(s => s.branchId === branch.id).map(sessionLabel).join(', ') || 'no session' }}</span></div></NCard>
  </div>
</template>

<style scoped>.branch-line { display:flex; gap:14px; flex-wrap:wrap; padding:8px 0; border-bottom:1px solid #414559; font-size:13px; }</style>
