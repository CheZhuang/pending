<!-- Activity: the live event log (a recent window of history + SSE) with filters, older
     history on demand, and full details per event. -->
<script setup>
import { computed, h, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { NAlert, NButton, NCard, NDataTable, NDescriptions, NDescriptionsItem, NDrawer, NDrawerContent, NEmpty, NInput, NSelect, NSpace, NSwitch, NTag } from 'naive-ui';
import { describe } from '../api/errors.js';
import { api } from '../api/index.js';
import { eventEvidence, eventSummary, eventTone, short, time, dateTime } from '../format.js';
import { sessionLabel } from '../model.js';
import { loadOlder, selectWorkspace, state } from '../state.js';
import { useData } from '../useData.js';

const { data: sessions } = useData(async () => (await api.sessions()).filter((s) => s.workspaceId === state.workspaceId),
  () => [state.workspaceId, state.changed.sessions]);
const sessionById = computed(() => new Map((sessions.value ?? []).map((s) => [s.id, s])));

const CATEGORIES = [
  { label: 'All events', value: 'all' },
  { label: 'Observed agent activity', value: 'observed' },
  { label: 'Policy decisions', value: 'policy' },
  { label: 'Tool approvals', value: 'tool' },
  { label: 'Main & supervision', value: 'context' },
  { label: 'Sessions', value: 'session' },
];
const match = {
  all: () => true,
  observed: (e) => e.mode === 'observed',
  policy: (e) => e.type === 'policy.decision',
  tool: (e) => e.type.startsWith('tool.'),
  context: (e) => /^(context|main|work|merge|conflict|correction)\./.test(e.type),
  session: (e) => e.type.startsWith('session.') || e.type === 'branch.created' || e.type === 'workspace.created',
};

const category = ref('all');
const route = useRoute();
// Linked from a task or session: /activity?session=<id> starts filtered to that agent.
const sessionFilter = ref(typeof route.query.session === 'string' ? route.query.session : 'all');
watch(() => route.query.session, (id) => { if (typeof id === 'string') sessionFilter.value = id; });
const search = ref('');
const denialsOnly = ref(false);
const paused = ref(false);
const frozen = ref([]);
watch(paused, (p) => { if (p) frozen.value = [...state.events]; });

const sessionOptions = computed(() => [{ label: 'All sessions', value: 'all' }, ...(sessions.value ?? []).map((s) => ({ label: sessionLabel(s), value: s.id }))]);

const rows = computed(() => {
  const source = paused.value ? frozen.value : state.events;
  const q = search.value.trim().toLowerCase();
  return source.filter((e) => match[category.value](e)
    && (sessionFilter.value === 'all' || e.sessionId === sessionFilter.value || e.payload?.actor?.sessionId === sessionFilter.value)
    && (!denialsOnly.value || eventTone(e) === 'error')
    && (!q || `${e.type} ${e.source} ${eventSummary(e)}`.toLowerCase().includes(q))).slice().reverse();
});

const selected = ref(null);
const who = (e) => {
  const s = sessionById.value.get(e.sessionId ?? e.payload?.actor?.sessionId);
  return s ? sessionLabel(s) : e.mode === 'controlled' ? 'gateway' : e.source;
};

const columns = [
  { title: 'Seq', key: 'sequence', width: 70, render: (e) => h('span', { class: 'mono muted' }, `#${e.sequence}`) },
  { title: 'Time', key: 'occurredAt', width: 90, render: (e) => h('span', { class: 'mono' }, time(e.occurredAt)) },
  { title: 'Who', key: 'who', width: 150, ellipsis: { tooltip: true }, render: who },
  {
    title: 'Type', key: 'type', width: 190,
    render: (e) => h(NTag, { size: 'small', bordered: false, type: eventTone(e) }, () => e.type),
  },
  { title: 'Summary', key: 'summary', ellipsis: { tooltip: true }, render: (e) => eventSummary(e) },
  {
    title: 'Evidence', key: 'mode', width: 180,
    render: (e) => h('span', { class: 'muted', style: 'font-size:12px' }, eventEvidence(e)),
  },
];
const rowProps = (e) => ({ style: 'cursor: pointer', onClick: () => { selected.value = e; } });
</script>

<template>
  <div class="page">
    <h1 class="page-title">Activity</h1>
    <p class="page-sub">Observed agent activity and every gateway decision, newest first. Observed events are telemetry, not proof of execution.</p>
    <NAlert v-if="state.history.error" type="error" :title="describe(state.history.error).title" style="margin-bottom: 12px">
      {{ describe(state.history.error).hint || 'Activity history could not be loaded.' }}
      <template #action><NButton size="small" @click="state.events.length ? loadOlder() : selectWorkspace(state.workspaceId)">Retry</NButton></template>
    </NAlert>

    <NCard size="small">
      <NSpace class="filters" :size="10" align="center" :wrap="true">
        <NSelect v-model:value="category" :options="CATEGORIES" size="small" style="width: 210px" />
        <NSelect v-model:value="sessionFilter" :options="sessionOptions" size="small" style="width: 200px" />
        <NInput v-model:value="search" size="small" clearable placeholder="Search type, file, command…" style="width: 240px" />
        <span class="toggle"><NSwitch v-model:value="denialsOnly" size="small" /> Denials &amp; stops only</span>
        <span class="toggle"><NSwitch v-model:value="paused" size="small" /> Pause</span>
        <span class="muted" style="font-size: 12px">{{ rows.length }} of {{ state.events.length }} loaded events</span>
      </NSpace>
      <NDataTable
        :columns="columns" :data="rows" :row-key="(e) => e.sequence" :row-props="rowProps"
        size="small" :bordered="false" virtual-scroll :max-height="'calc(100vh - 340px)'" :scroll-x="900" style="margin-top: 12px"
        :loading="state.history.loading"
      >
        <template #empty><NEmpty size="small" :description="state.history.loading ? 'Loading recent activity…' : state.events.length ? 'No loaded event matches these filters.' : 'No activity recorded yet.'" /></template>
      </NDataTable>
      <div class="older">
        <template v-if="state.history.hasOlder">
          <span class="muted">Showing recent activity only<template v-if="paused"> (paused)</template>.</span>
          <NButton size="small" secondary :loading="state.history.loadingOlder" :disabled="paused" @click="loadOlder">Load older events</NButton>
        </template>
        <span v-else-if="!state.history.loading && state.events.length" class="muted">Beginning of this workspace's history.</span>
      </div>
    </NCard>

    <NDrawer :show="!!selected" :width="'min(560px, 100vw)'" @update:show="(v) => { if (!v) selected = null; }">
      <NDrawerContent v-if="selected" :title="`#${selected.sequence} · ${selected.type}`" closable>
        <NDescriptions :column="1" label-placement="left" size="small" bordered>
          <NDescriptionsItem label="Summary">{{ eventSummary(selected) }}</NDescriptionsItem>
          <NDescriptionsItem label="Evidence">{{ eventEvidence(selected) }}</NDescriptionsItem>
          <NDescriptionsItem label="Who">{{ who(selected) }}</NDescriptionsItem>
          <NDescriptionsItem label="Source"><span class="mono">{{ selected.source }}</span></NDescriptionsItem>
          <NDescriptionsItem label="Native id"><span class="mono">{{ selected.nativeId }}</span></NDescriptionsItem>
          <NDescriptionsItem v-if="selected.sessionId" label="Session"><span class="mono">{{ short(selected.sessionId) }}</span></NDescriptionsItem>
          <NDescriptionsItem label="Occurred">{{ dateTime(selected.occurredAt) }}</NDescriptionsItem>
        </NDescriptions>
        <h4 style="margin: 18px 0 8px">Payload</h4>
        <pre class="json mono">{{ JSON.stringify(selected.payload, null, 2) }}</pre>
      </NDrawerContent>
    </NDrawer>
  </div>
</template>

<style scoped>
.toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; }
.older { display: flex; align-items: center; gap: 10px; justify-content: center; margin-top: 10px; font-size: 12px; }
</style>
