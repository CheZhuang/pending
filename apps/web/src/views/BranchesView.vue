<script setup>
import { computed, nextTick, ref } from 'vue';
import { NAlert, NButton, NCard, NEmpty, NInput, NSelect, NSpace, NTag, useMessage } from 'naive-ui';
import { api } from '../api/index.js';
import { describe } from '../api/errors.js';
import { state } from '../state.js';
import { useData } from '../useData.js';
import { dateTime, eventEvidence, short } from '../format.js';
import BranchGraph from '../components/BranchGraph.vue';

const message = useMessage();
const { data, error, reload } = useData(() => api.supervision(state.workspaceId), () => [state.workspaceId, state.changed.context, state.changed.sessions, state.changed.supervision]);
const selected = ref(null); const selectedWork = ref(null); const correction = ref(''); const busy = ref(false);
const branches = computed(() => data.value?.branches ?? []);
const current = computed(() => branches.value.find(x => x.branch.id === selected.value) ?? branches.value[0] ?? null);
async function selectFromTree({ branchId, workId }) {
  selected.value = branchId; selectedWork.value = workId;
  if (!workId) return;
  await nextTick();
  document.getElementById(`work-${workId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
const correctionStateLabel = (state) => ({ 'not-retrieved': 'Not retrieved', retrieved: 'Retrieved · awaiting acknowledgment', acknowledged: 'Acknowledged' }[state] ?? state);
const correctionStateType = (state) => state === 'acknowledged' ? 'success' : state === 'retrieved' ? 'warning' : 'default';
async function disposition(work, decision) {
  if (!current.value) return;
  busy.value = true;
  try {
    await api.mergeWork(current.value.branch.id, { workIds: [work.id], decision, expectedMainRevision: data.value.main.revision });
    await reload(); message.success(decision === 'accepted' ? 'Work accepted into Main' : 'Work rejected');
  } catch (e) { message.error(describe(e).hint); } finally { busy.value = false; }
}
async function sendCorrection() {
  if (!current.value || !correction.value.trim()) return;
  busy.value = true;
  try { await api.correctBranch(current.value.branch.id, { body: correction.value.trim() }); correction.value = ''; await reload(); message.success('Correction recorded'); }
  catch (e) { message.error(describe(e).hint); } finally { busy.value = false; }
}
</script>

<template>
  <div class="page">
    <h1 class="page-title">Branches</h1>
    <p class="page-sub">Logical agent work records, independent of Git branches and filesystem layout. Review proposed work before accepting it into Main.</p>
    <NAlert v-if="error" type="error" :title="describe(error).title">{{ describe(error).hint }}</NAlert>
    <NCard v-if="branches.length" title="Branch tree" size="small" style="margin-bottom: 14px">
      <BranchGraph :context="data" :selected-branch-id="current?.branch.id" :selected-work-id="selectedWork" @select="selectFromTree" />
    </NCard>
    <NSelect v-if="branches.length" :value="current?.branch.id" @update:value="(v) => { selected = v; selectedWork = null; }" :options="branches.map(x => ({ label: `${x.branch.name} · ${x.work.filter(w => w.state === 'proposed').length} proposed`, value: x.branch.id }))" style="max-width: 360px; margin-bottom: 14px" />
    <template v-if="current">
      <NCard size="small" style="margin-bottom: 14px">
        <template #header>{{ current.branch.name }} <span class="muted">· revision {{ current.branch.revision }}</span></template>
        <div class="muted">Sessions: {{ current.sessions.map(s => s.label || s.runtime).join(', ') || 'none' }}</div>
        <div style="margin-top:8px">Reported file references: <NTag v-for="file in current.files" :key="file.rootId + file.path" size="small" class="mono" style="margin:2px">{{ file.rootId }}:{{ file.path }}</NTag><span v-if="!current.files.length" class="muted">none reported</span></div>
        <p class="muted" style="font-size:11px;margin:6px 0 0">These are agent or adapter reports, not a source diff or filesystem inspection.</p>
      </NCard>
      <h2 class="section-title">Proposed work</h2>
      <NEmpty v-if="!current.work.length" description="No work proposals on this branch yet." />
      <NCard v-for="work in [...current.work].reverse()" :id="`work-${work.id}`" :key="work.id" size="small" style="margin-bottom: 10px" :class="{ 'work-selected': work.id === selectedWork }">
        <template #header>{{ work.intent || 'Work proposal' }} <NTag size="tiny" :type="work.state === 'proposed' ? 'warning' : work.state === 'accepted' ? 'success' : 'default'" :bordered="false">{{ work.state }}</NTag></template>
        <p class="work-body">{{ work.body }}</p>
        <NSpace v-if="work.files?.length" size="small"><NTag v-for="f in work.files" :key="f.rootId + f.path" size="small" class="mono">{{ f.rootId }}:{{ f.path }}</NTag></NSpace>
        <p class="muted" style="font-size:11px">{{ dateTime(work.createdAt) }} · session {{ short(work.sessionId) }}</p>
        <NSpace v-if="work.state === 'proposed'"><NButton type="primary" size="small" :disabled="busy" @click="disposition(work, 'accepted')">Accept into Main</NButton><NButton type="error" secondary size="small" :disabled="busy" @click="disposition(work, 'rejected')">Reject</NButton></NSpace>
      </NCard>
      <NCard title="Corrections to this branch" size="small" style="margin-top:16px">
        <p class="muted" style="font-size:12px">Corrections are durable guidance. Managed runners try to surface new items through the runtime; acknowledgment means the agent confirmed retrieval, not that it complied.</p>
        <div v-for="item in current.corrections" :key="item.id" class="correction">
          <div>{{ item.body }} <span class="muted">· {{ dateTime(item.createdAt) }}</span></div>
          <NSpace size="small" style="margin-top:6px">
            <NTag v-for="delivery in item.deliveries ?? []" :key="delivery.sessionId" size="tiny" :type="correctionStateType(delivery.state)" :bordered="false">{{ delivery.runtime }} · {{ short(delivery.sessionId) }} · {{ correctionStateLabel(delivery.state) }}</NTag>
          </NSpace>
          <span v-if="!item.deliveries?.length" class="muted" style="font-size:11px">No active session · Not retrieved</span>
        </div>
        <NInput v-model:value="correction" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" placeholder="What should the agent correct or reconsider?" />
        <NSpace justify="end" style="margin-top:8px"><NButton type="primary" :disabled="!correction.trim() || busy" @click="sendCorrection">Send correction</NButton></NSpace>
      </NCard>
      <NCard title="Recent branch activity" size="small" style="margin-top:14px">
        <p class="muted" style="font-size:11px">Observed events are runtime reports. Controlled tool events show interception decisions and do not prove the tool completed.</p>
        <div v-for="event in (current.recentActivity ?? []).slice(0, 12)" :key="event.id" class="event-line"><span class="mono muted">#{{ event.sequence }}</span> <NTag size="tiny" :bordered="false" :type="eventEvidence(event) === 'Intercepted tool decision' ? 'warning' : eventEvidence(event) === 'Runtime-reported result' ? 'success' : 'info'">{{ eventEvidence(event) }}</NTag> {{ event.source }} · {{ event.type }} <span class="muted">{{ dateTime(event.occurredAt) }}</span></div>
      </NCard>
    </template>
    <NEmpty v-else-if="!error" description="No branches found." />
  </div>
</template>

<style scoped>.section-title { font-size: 15px; margin: 18px 0 10px; }.work-body { white-space: pre-wrap; line-height: 1.55; }.correction { padding: 8px 0; border-bottom: 1px solid #414559; white-space: pre-wrap; }/* highlight the proposal picked in the tree */ .work-selected { border-color: #babbf1; box-shadow: 0 0 0 1px #babbf166; }.event-line { padding: 6px 0; border-bottom: 1px solid #414559; font-size: 12px; }</style>
