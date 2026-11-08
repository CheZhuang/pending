<script setup>
import { computed, reactive, ref } from 'vue';
import { NAlert, NButton, NCard, NEmpty, NInput, NSelect, NSpin, NTag, useDialog, useMessage } from 'naive-ui';
import { api } from '../api/index.js';
import { describe, errorText } from '../api/errors.js';
import { state } from '../state.js';
import { useData } from '../useData.js';
import { dateTime } from '../format.js';

const message = useMessage();
const dialog = useDialog();
const busy = ref(null);
const reporting = ref(false);
const { data, error, reload } = useData(() => api.conflicts(state.workspaceId), () => [state.workspaceId, state.changed.context, state.changed.supervision]);
const { data: supervision } = useData(() => api.supervision(state.workspaceId), () => [state.workspaceId, state.changed.context, state.changed.supervision]);
const explanations = reactive({});
const reportBranches = ref([]); const reportMain = ref(null); const reportText = ref('');
const order = ['potential', 'confirmed', 'resolved', 'dismissed'];
const conflicts = computed(() => [...(data.value ?? [])].sort((a,b) => order.indexOf(a.status) - order.indexOf(b.status)));
const conflictLabel = (id) => id.includes(':') ? `${id.split(':').slice(0, -1).join(':')}:${id.split(':').at(-1).slice(0, 8)}` : id.slice(0, 8);
async function decide(conflict, status) {
  const explanation = explanations[conflict.id]?.trim();
  if (!explanation || busy.value) return;
  busy.value = `${conflict.id}:${status}`;
  try { await api.decideConflict(state.workspaceId, conflict.id, { status, explanation }); delete explanations[conflict.id]; message.success(`Conflict marked ${status}`); }
  catch (e) { message.error(errorText(e), { duration: 7000 }); }
  finally { busy.value = null; await reload(); }
}
// Dismissing removes the warning from review; ask once, since it is easy to click by mistake.
function confirmDismiss(conflict) {
  dialog.warning({
    title: 'Dismiss this conflict?',
    content: 'It leaves the review list as not a real conflict. Your explanation is kept in the audit log.',
    positiveText: 'Dismiss', negativeText: 'Cancel',
    onPositiveClick: () => decide(conflict, 'dismissed'),
  });
}
async function report() {
  if (!reportBranches.value.length || !reportText.value.trim() || reporting.value) return;
  reporting.value = true;
  try {
    await api.reportConflict(state.workspaceId, { branchIds: reportBranches.value, ...(reportMain.value ? { mainEntryId: reportMain.value } : {}), explanation: reportText.value.trim() });
    reportBranches.value = []; reportMain.value = null; reportText.value = ''; await reload(); message.success('Potential conflict reported for review');
  } catch (e) { message.error(errorText(e), { duration: 7000 }); }
  finally { reporting.value = false; }
}
</script>

<template>
  <div class="page">
    <h1 class="page-title">Conflicts</h1>
    <p class="page-sub">File overlap and reported incompatibility are evidence to inspect. Overlap is potential; only a person can confirm, resolve, or dismiss it.</p>
    <NAlert v-if="error" type="error" :title="describe(error).title">{{ describe(error).hint }}</NAlert>
    <NCard title="Report a possible incompatibility" size="small" style="margin-bottom:14px">
      <p class="muted" style="font-size:12px">Use this when two pieces of work may conflict semantically. Your report starts as potential and requires human assessment.</p>
      <NSelect v-model:value="reportBranches" multiple :options="(supervision?.branches ?? []).filter(x => x.branch.name !== 'main').map(x => ({ label:x.branch.name, value:x.branch.id }))" placeholder="Choose affected branches" style="margin-bottom:8px" />
      <NSelect v-model:value="reportMain" clearable :options="(supervision?.main.entries ?? []).filter(e => !e.removed).map(e => ({ label:e.body.slice(0,90), value:e.id }))" placeholder="Related Main expectation (optional)" style="margin-bottom:8px" />
      <NInput v-model:value="reportText" type="textarea" :autosize="{ minRows:2, maxRows:4 }" placeholder="Explain why the work may be incompatible" />
      <div class="actions" style="margin-top:8px"><NButton type="primary" :loading="reporting" :disabled="!reportBranches.length || !reportText.trim()" @click="report">Report potential conflict</NButton></div>
    </NCard>
    <div v-if="!data && !error" class="center"><NSpin /></div>
    <NEmpty v-else-if="!conflicts.length && !error" description="No conflict evidence has been recorded." />
    <NCard v-for="conflict in conflicts" :key="conflict.id" size="small" style="margin-bottom: 12px">
      <template #header><NTag size="small" :type="conflict.status === 'confirmed' ? 'error' : conflict.status === 'potential' ? 'warning' : 'success'" :bordered="false">{{ conflict.status }}</NTag> <span class="mono">{{ conflictLabel(conflict.id) }}</span></template>
      <p class="explanation">{{ conflict.explanation }}</p>
      <p class="related"><strong>Branches:</strong> {{ (conflict.branchIds ?? []).map(id => supervision?.branches.find(b => b.branch.id === id)?.branch.name ?? id).join(', ') || 'none' }}</p>
      <div v-for="branchId in conflict.branchIds ?? []" :key="branchId">
        <div v-for="item in (supervision?.branches.find(b => b.branch.id === branchId)?.work ?? []).filter(w => !conflict.evidenceIds?.length || conflict.evidenceIds.includes(w.id))" :key="item.id" class="evidence"><strong>{{ item.intent || 'Branch work' }}:</strong> {{ item.body }}</div>
      </div>
      <div v-if="conflict.mainEntryId" class="evidence"><strong>Main expectation:</strong> {{ supervision?.main.entries.find(e => e.id === conflict.mainEntryId)?.body ?? conflict.mainEntryId }}</div>
      <div class="files">Files: <NTag v-for="file in conflict.files" :key="file.rootId + file.path" size="small" class="mono">{{ file.rootId }}:{{ file.path }}</NTag><span v-if="!conflict.files?.length" class="muted">none attached</span></div>
      <NCard v-for="evidence in conflict.fileEvidence ?? []" :key="evidence.file.rootId + evidence.file.path" size="small" class="checkout-evidence">
        <template #header>Current checkout · <span class="mono">{{ evidence.file.rootId }}:{{ evidence.file.path }}</span></template>
        <p class="muted evidence-meta">Git status: <code>{{ evidence.gitStatus }}</code> · {{ evidence.currentState.exists ? `${evidence.currentState.bytes ?? '?'} bytes` : 'file missing' }}<template v-if="evidence.currentState.sha256"> · SHA-256 {{ evidence.currentState.sha256.slice(0, 16) }}</template><template v-if="evidence.currentState.modifiedAt"> · modified {{ dateTime(evidence.currentState.modifiedAt) }}</template></p>
        <p v-if="evidence.gitError" class="muted">Git history unavailable: {{ evidence.gitError }}</p>
        <p v-if="evidence.currentState.unavailableReason" class="muted">{{ evidence.currentState.unavailableReason }}</p>
        <div v-if="evidence.recentChanges?.length" class="recent-changes"><strong>Recent commits:</strong><div v-for="commit in evidence.recentChanges" :key="commit.commit"><code>{{ commit.commit.slice(0, 8) }}</code> · {{ dateTime(commit.date) }} · {{ commit.subject }}</div></div>
        <details v-if="evidence.workingTreeDiff"><summary>Current working tree diff</summary><pre class="git-diff">{{ evidence.workingTreeDiff }}</pre></details>
        <p v-else-if="!evidence.gitError" class="muted">No uncommitted diff for this file.</p>
      </NCard>
      <p v-if="conflict.fileEvidence?.length" class="muted" style="font-size:11px">This evidence describes the current shared checkout; it is not attributed to a logical Agentree branch or agent.</p>
      <p class="muted" style="font-size:12px">{{ conflict.branchIds?.length ?? 0 }} affected branch(es) · {{ conflict.evidenceIds?.length ?? 0 }} evidence item(s) <template v-if="conflict.updatedAt">· {{ dateTime(conflict.updatedAt) }}</template></p>
      <template v-if="['potential','confirmed'].includes(conflict.status)">
        <NInput v-model:value="explanations[conflict.id]" size="small" placeholder="Your assessment is required for this decision" style="margin-bottom:8px" />
        <div class="actions">
          <NButton v-if="conflict.status === 'potential'" size="small" type="warning" :loading="busy === `${conflict.id}:confirmed`" :disabled="!explanations[conflict.id]?.trim() || !!busy" @click="decide(conflict, 'confirmed')">Confirm conflict</NButton>
          <NButton size="small" type="success" secondary :loading="busy === `${conflict.id}:resolved`" :disabled="!explanations[conflict.id]?.trim() || !!busy" @click="decide(conflict, 'resolved')">Mark resolved</NButton>
          <NButton size="small" secondary :loading="busy === `${conflict.id}:dismissed`" :disabled="!explanations[conflict.id]?.trim() || !!busy" @click="confirmDismiss(conflict)">Dismiss</NButton>
        </div>
      </template>
    </NCard>
  </div>
</template>

<style scoped>.center { display: flex; justify-content: center; padding: 40px; }.explanation { white-space: pre-wrap; line-height: 1.5; }.related,.evidence { font-size:12px; margin:6px 0; }.evidence { padding-left:10px; border-left:2px solid #737994; white-space:pre-wrap; }.files { display:flex; align-items:center; gap:5px; flex-wrap:wrap; margin:8px 0; }.actions { display:flex; gap:8px; flex-wrap:wrap; }.checkout-evidence { margin:8px 0; }.evidence-meta,.recent-changes { font-size:11px; }.recent-changes { margin:8px 0; }.git-diff { max-height:320px; overflow:auto; padding:10px; background:#11131a; white-space:pre; font-size:11px; }</style>
