<script setup>
import { computed, h, reactive } from 'vue';
import { NAlert, NButton, NCard, NDataTable, NEmpty, NGrid, NGridItem, NInput, NProgress, NSpace, NSpin, NTag, useNotification } from 'naive-ui';
import { api } from '../api/index.js';
import { describe, errorText } from '../api/errors.js';
import { clip, dateTime, short, toolTarget } from '../format.js';
import { findSession, sessionLabel } from '../model.js';
import { state } from '../state.js';
import { useData, useNow } from '../useData.js';

const notify = useNotification(); const now = useNow();
const { data: approvals, error, reload } = useData(async () => (await api.approvals()).filter(a => a.workspaceId === state.workspaceId), () => [state.workspaceId, state.changed.approvals, state.changed.sessions]);
const { data: sessions } = useData(async () => (await api.sessions()).filter(s => s.workspaceId === state.workspaceId), () => [state.workspaceId, state.changed.sessions]);
const pending = computed(() => (approvals.value ?? []).filter(a => a.state === 'pending'));
const history = computed(() => (approvals.value ?? []).filter(a => a.state !== 'pending').slice().reverse().slice(0,30));
const reasons = reactive({}); const busy = reactive({});
const remaining = (a) => Math.max(0, Math.ceil((Date.parse(a.expiresAt) - now.value) / 1000));
async function decide(a, decision) {
  busy[a.id] = decision;
  try { const result = await api.decideApproval(a.id, decision, reasons[a.id]?.trim() || undefined); notify.success({ title: decision === 'approved' ? 'Tool call allowed' : 'Tool call denied', content: `${a.tool} ${clip(toolTarget(a.input), 50)} → ${result.state}. This is a decision, not proof the tool ran.`, duration: 4500 }); }
  catch (e) { notify.error({ title: decision === 'approved' ? 'Allow failed' : 'Deny failed', content: errorText(e), duration: 7000 }); }
  finally { delete busy[a.id]; reload(); }
}
const columns = [
  { title: 'Tool', key: 'tool', width: 90 },
  { title: 'Input', key: 'input', ellipsis: { tooltip: true }, render: a => h('span', { class:'mono' }, toolTarget(a.input) || JSON.stringify(a.input)) },
  { title: 'Session', key: 'sessionId', width: 150, render: a => sessionLabel(findSession(sessions.value, a.sessionId)) },
  { title: 'Result', key: 'state', width: 100, render: a => h(NTag, { size:'small', bordered:false, type:a.state === 'approved' ? 'success' : a.state === 'timeout' ? 'warning' : 'error' }, () => a.state) },
  { title: 'Reason', key: 'reason', ellipsis: { tooltip:true }, render:a => a.reason ?? '—' },
  { title: 'Decided', key:'decidedAt', width:170, render:a => a.decidedAt ? dateTime(a.decidedAt) : '—' },
];
</script>

<template>
  <div class="page">
    <h1 class="page-title">Tool approvals</h1>
    <p class="page-sub">Decide whether a controlled tool call may proceed. An approval response is not execution evidence.</p>
    <NAlert v-if="error" type="error" :title="describe(error).title">{{ describe(error).hint }}</NAlert>
    <NCard size="small">
      <template #header>Waiting <NTag v-if="pending.length" size="small" type="warning" round style="margin-left:6px">{{ pending.length }}</NTag></template>
      <div v-if="!approvals && !error" class="center"><NSpin size="small" /></div>
      <NEmpty v-else-if="!pending.length && !error" description="No tool call is waiting for a decision." size="small" />
      <NGrid v-else cols="1 m:2" responsive="screen" :x-gap="12" :y-gap="12">
        <NGridItem v-for="a in pending" :key="a.id"><div class="approval">
          <div class="row"><NTag type="warning" size="small" :bordered="false">{{ a.tool }}</NTag><span class="muted">{{ sessionLabel(findSession(sessions, a.sessionId)) }}</span><span class="spacer" /><span v-if="remaining(a)" class="mono">{{ remaining(a) }}s</span><NTag v-else size="small" :bordered="false">Expired · the Gateway denies it on timeout</NTag></div>
          <pre class="json mono cmd">{{ toolTarget(a.input) || JSON.stringify(a.input, null, 2) }}</pre>
          <NProgress type="line" :percentage="Math.max(0, ((Date.parse(a.expiresAt)-now)/(Date.parse(a.expiresAt)-Date.parse(a.createdAt)))*100)" :show-indicator="false" :height="4" />
          <NInput v-model:value="reasons[a.id]" size="small" placeholder="Reason (optional, recorded in the audit log)" style="margin:10px 0" />
          <NSpace><NButton type="success" size="small" :loading="busy[a.id]==='approved'" :disabled="!!busy[a.id] || !remaining(a)" @click="decide(a,'approved')">Allow</NButton><NButton type="error" size="small" secondary :loading="busy[a.id]==='denied'" :disabled="!!busy[a.id] || !remaining(a)" @click="decide(a,'denied')">Deny</NButton></NSpace>
        </div></NGridItem>
      </NGrid>
      <NDataTable v-if="history.length" :columns="columns" :data="history" size="small" :bordered="false" :scroll-x="820" style="margin-top:14px" />
    </NCard>
  </div>
</template>

<style scoped>.center { display:flex; justify-content:center; padding:24px; }.approval { border:1px solid #e5c89055; border-radius:6px; padding:12px; background:#2b2e3f; }.row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }.spacer { flex:1; }.cmd { margin:10px 0 8px; max-height:120px; color:#e5c890; }</style>
