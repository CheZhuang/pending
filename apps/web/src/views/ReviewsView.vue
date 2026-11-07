<!-- Reviews: pending tool approvals and context merge reviews. Every decision is
     sent to the gateway; the page shows the gateway's resulting state or its error. -->
<script setup>
import { computed, h, reactive, ref, watch } from 'vue';
import {
  NAlert, NButton, NCard, NCheckbox, NDataTable, NEmpty, NGrid, NGridItem, NInput, NProgress, NRadio, NRadioGroup, NSpace, NTag, useNotification,
} from 'naive-ui';
import CommitCard from '../components/CommitCard.vue';
import AuthorityTag from '../components/AuthorityTag.vue';
import { api } from '../api/index.js';
import { describe } from '../api/errors.js';
import { clip, dateTime, short, toolTarget } from '../format.js';
import { branchName, findSession, loadWorkspace, sessionLabel } from '../model.js';
import { state, workspace } from '../state.js';
import { useData, useNow } from '../useData.js';

const notify = useNotification();
const now = useNow();

// ---------------- tool approvals ----------------
const { data: approvals, error: approvalsError, reload: reloadApprovals } = useData(
  async () => (await api.approvals()).filter((a) => a.workspaceId === state.workspaceId),
  () => [state.workspaceId, state.changed.approvals, state.changed.sessions],
);
const { data: model, error: modelError, reload: reloadModel } = useData(
  () => loadWorkspace(workspace()),
  () => [state.workspaceId, state.changed.reviews, state.changed.context, state.changed.sessions],
);

const pendingApprovals = computed(() => (approvals.value ?? []).filter((a) => a.state === 'pending'));
const decidedApprovals = computed(() => (approvals.value ?? []).filter((a) => a.state !== 'pending').slice().reverse());
const reasons = reactive({});
const busy = reactive({});

function remaining(a) {
  const total = Date.parse(a.expiresAt) - Date.parse(a.createdAt);
  const left = Math.max(0, Date.parse(a.expiresAt) - now.value);
  return { seconds: Math.ceil(left / 1000), percent: total > 0 ? (left / total) * 100 : 0 };
}

function fail(e, context) {
  const d = describe(e);
  notify.error({ title: d.title, content: [context, d.hint].filter(Boolean).join(' '), duration: 7000 });
}

async function decideApproval(a, decision) {
  busy[a.id] = decision;
  try {
    const result = await api.decideApproval(a.id, decision, reasons[a.id]?.trim() || undefined);
    notify.success({
      title: decision === 'approved' ? 'Tool call allowed' : 'Tool call denied',
      content: `${a.tool} ${clip(toolTarget(a.input), 50)} → ${result.state}. The hook receives this decision; it is not proof the tool ran.`,
      duration: 5000,
    });
  } catch (e) {
    fail(e);
  } finally {
    delete busy[a.id];
    reloadApprovals();
  }
}

const approvalColumns = [
  { title: 'Tool', key: 'tool', width: 90 },
  { title: 'Input', key: 'input', ellipsis: { tooltip: true }, render: (a) => h('span', { class: 'mono' }, toolTarget(a.input) || JSON.stringify(a.input)) },
  { title: 'Session', key: 'sessionId', width: 150, render: (a) => sessionLabel(findSession(model.value?.sessions, a.sessionId)) },
  { title: 'Result', key: 'state', width: 110, render: (a) => h(NTag, { size: 'small', bordered: false, type: a.state === 'approved' ? 'success' : a.state === 'timeout' ? 'warning' : 'error' }, () => a.state) },
  { title: 'Reason', key: 'reason', ellipsis: { tooltip: true }, render: (a) => a.reason ?? '—' },
  { title: 'Decided', key: 'decidedAt', width: 170, render: (a) => (a.decidedAt ? dateTime(a.decidedAt) : '—') },
];

// ---------------- merge reviews ----------------
const applyAfter = ref(true);
const choices = reactive({});

const reviewRows = computed(() => {
  const m = model.value;
  if (!m) return [];
  return m.reviews.map((review) => {
    const merge = m.merges.find((x) => x.id === review.mergeId);
    return { review, merge, incoming: (merge?.commitIds ?? []).map((id) => m.commits.get(id)) };
  });
});
const pendingReviews = computed(() => reviewRows.value.filter((r) => r.review.state === 'pending'));
/** Approved by a human but the merge was not applied (e.g. apply failed as stale). */
const unapplied = computed(() => reviewRows.value.filter((r) => r.review.state === 'approved' && r.merge?.state === 'pending'));
const decidedReviews = computed(() => reviewRows.value.filter((r) => r.review.state !== 'pending' && !unapplied.value.includes(r)).reverse());

// One choice (existing | incoming | null) per conflict, created when a review appears.
watch(pendingReviews, (rows) => {
  for (const { review } of rows) if (!choices[review.id]) choices[review.id] = review.conflicts.map(() => null);
}, { immediate: true });
const choiceFor = (review) => choices[review.id] ?? [];
const ready = (review) => review.conflicts.length === 0 || choiceFor(review).every(Boolean);

async function apply(row) {
  const merged = await api.applyMerge(row.merge.id);
  notify.success({ title: 'Merge applied', content: `${branchName(model.value.branches, row.merge.sourceBranchId)} → ${branchName(model.value.branches, row.merge.targetBranchId)}: agents receive it on their next context sync. (${merged.state})`, duration: 5000 });
}

async function decide(row, decision) {
  const { review } = row;
  busy[review.id] = decision;
  try {
    const resolutions = decision === 'approved' && review.conflicts.length
      ? review.conflicts.map((c, i) => ({ existingCommitId: c.existingCommitId, incomingCommitId: c.incomingCommitId, selectedCommitId: choiceFor(review)[i] === 'existing' ? c.existingCommitId : c.incomingCommitId }))
      : undefined;
    const result = await api.resolveReview(review.id, decision, resolutions);
    if (decision === 'rejected') {
      notify.info({ title: 'Merge rejected', content: 'The proposal stays on its branch as an unaccepted draft.', duration: 4000 });
    } else if (applyAfter.value) {
      try {
        await apply(row);
      } catch (e) {
        fail(e, `Review ${short(result.id)} is approved, but the merge was not applied.`);
      }
    } else {
      notify.success({ title: 'Review approved', content: 'Apply the merge when you are ready.', duration: 4000 });
    }
  } catch (e) {
    fail(e);
  } finally {
    delete busy[review.id];
    delete choices[review.id];
    reloadModel();
  }
}

async function applyOnly(row) {
  busy[row.review.id] = 'apply';
  try { await apply(row); } catch (e) { fail(e); } finally { delete busy[row.review.id]; reloadModel(); }
}

const historyColumns = computed(() => [
  { title: 'Review', key: 'id', width: 100, render: (r) => h('span', { class: 'mono' }, short(r.review.id)) },
  { title: 'Merge', key: 'merge', render: (r) => `${branchName(model.value?.branches, r.merge?.sourceBranchId)} → ${branchName(model.value?.branches, r.merge?.targetBranchId)}` },
  { title: 'Decision', key: 'decision', width: 110, render: (r) => h(NTag, { size: 'small', bordered: false, type: r.review.decision === 'approved' ? 'success' : 'error' }, () => r.review.decision ?? r.review.state) },
  { title: 'Merge state', key: 'mstate', width: 110, render: (r) => r.merge?.state ?? '—' },
  { title: 'Conflicts', key: 'conflicts', width: 90, render: (r) => r.review.conflicts.length },
  { title: 'Decided by', key: 'by', width: 130, render: (r) => r.review.decidedBy ?? '—' },
]);
</script>

<template>
  <div class="page">
    <h1 class="page-title">Reviews</h1>
    <p class="page-sub">Humans decide here. Agents cannot approve their own tool calls or merges; the gateway enforces and audits every decision.</p>

    <!-- Tool approvals -->
    <NCard size="small" style="margin-bottom: 18px">
      <template #header>Tool approvals <NTag v-if="pendingApprovals.length" size="small" type="warning" round style="margin-left: 6px">{{ pendingApprovals.length }} waiting</NTag></template>
      <template #header-extra><span class="muted" style="font-size: 12px">Claude Code pre-execution hook</span></template>
      <NAlert v-if="approvalsError" type="error" :title="describe(approvalsError).title">{{ describe(approvalsError).hint }}</NAlert>
      <NEmpty v-else-if="!pendingApprovals.length" description="No tool call is waiting for a decision." size="small" style="padding: 12px 0" />
      <NGrid v-else cols="1 m:2" responsive="screen" :x-gap="12" :y-gap="12">
        <NGridItem v-for="a in pendingApprovals" :key="a.id">
          <div class="approval">
            <div class="row">
              <NTag type="warning" size="small" :bordered="false">{{ a.tool }}</NTag>
              <span class="muted">{{ sessionLabel(findSession(model?.sessions, a.sessionId)) }}</span>
              <span class="spacer" />
              <span class="mono" :class="{ urgent: remaining(a).seconds < 20 }">{{ remaining(a).seconds }}s</span>
            </div>
            <pre class="json mono cmd">{{ toolTarget(a.input) || JSON.stringify(a.input, null, 2) }}</pre>
            <NProgress type="line" :percentage="remaining(a).percent" :show-indicator="false" :height="4" :status="remaining(a).seconds < 20 ? 'error' : 'warning'" />
            <NInput v-model:value="reasons[a.id]" size="small" placeholder="Reason (optional, recorded in the audit log)" style="margin: 10px 0" />
            <NSpace>
              <NButton type="success" size="small" :loading="busy[a.id] === 'approved'" :disabled="!!busy[a.id] || remaining(a).seconds === 0" @click="decideApproval(a, 'approved')">Allow</NButton>
              <NButton type="error" size="small" secondary :loading="busy[a.id] === 'denied'" :disabled="!!busy[a.id] || remaining(a).seconds === 0" @click="decideApproval(a, 'denied')">Deny</NButton>
            </NSpace>
          </div>
        </NGridItem>
      </NGrid>
      <NDataTable v-if="decidedApprovals.length" :columns="approvalColumns" :data="decidedApprovals.slice(0, 20)" size="small" :bordered="false" :scroll-x="820" style="margin-top: 14px" />
    </NCard>

    <!-- Merge reviews -->
    <NCard size="small">
      <template #header>Context merge reviews <NTag v-if="pendingReviews.length" size="small" type="warning" round style="margin-left: 6px">{{ pendingReviews.length }} waiting</NTag></template>
      <template #header-extra><NCheckbox v-model:checked="applyAfter" size="small">Apply merge after approval</NCheckbox></template>
      <NAlert v-if="modelError" type="error" :title="describe(modelError).title">{{ describe(modelError).hint }}</NAlert>

      <div v-for="row in unapplied" :key="row.review.id" class="review">
        <NAlert type="warning" :title="`Review ${short(row.review.id)} is approved but its merge is not applied`">
          {{ branchName(model.branches, row.merge.sourceBranchId) }} → {{ branchName(model.branches, row.merge.targetBranchId) }}.
          If applying fails as stale, ask the agent for a new merge request.
          <template #action><NButton size="small" type="primary" :loading="busy[row.review.id] === 'apply'" @click="applyOnly(row)">Apply merge</NButton></template>
        </NAlert>
      </div>

      <NEmpty v-if="!pendingReviews.length && !modelError" description="No merge request is waiting for review." size="small" style="padding: 12px 0" />
      <div v-for="row in pendingReviews" :key="row.review.id" class="review">
        <div class="row" style="margin-bottom: 10px">
          <strong>{{ branchName(model.branches, row.merge?.sourceBranchId) }} → {{ branchName(model.branches, row.merge?.targetBranchId) }}</strong>
          <span class="mono muted">review {{ short(row.review.id) }} · merge {{ short(row.merge?.id) }}</span>
          <NTag v-if="row.review.conflicts.length" size="small" type="error" :bordered="false">{{ row.review.conflicts.length }} conflict(s)</NTag>
          <NTag v-else size="small" :bordered="false">no conflicts · main always needs a human</NTag>
        </div>

        <template v-if="!row.review.conflicts.length">
          <div class="muted section">Incoming</div>
          <NSpace vertical :size="8">
            <CommitCard v-for="c in row.incoming" :key="c?.id" :commit="c" :model="model" :authority="c?.knowledge.kind === 'decision' ? 'proposed-decision' : 'finding'" />
          </NSpace>
        </template>

        <div v-for="(conflict, i) in row.review.conflicts" :key="i" class="conflict">
          <div class="section"><span class="mono">[{{ i + 1 }}] {{ conflict.key }}</span> <span class="muted">· same key, overlapping scope, different body — choose which one is in force</span></div>
          <NRadioGroup v-model:value="choiceFor(row.review)[i]" style="width: 100%">
            <NGrid cols="1 m:2" responsive="screen" :x-gap="12" :y-gap="12">
              <NGridItem>
                <label class="choice">
                  <NRadio value="existing">Keep existing</NRadio>
                  <CommitCard :commit="model.commits.get(conflict.existingCommitId)" :model="model" authority="accepted-decision" label="existing" :selected="choiceFor(row.review)[i] === 'existing'" />
                </label>
              </NGridItem>
              <NGridItem>
                <label class="choice">
                  <NRadio value="incoming">Take incoming</NRadio>
                  <CommitCard :commit="model.commits.get(conflict.incomingCommitId)" :model="model" authority="proposed-decision" label="incoming" :selected="choiceFor(row.review)[i] === 'incoming'" />
                </label>
              </NGridItem>
            </NGrid>
          </NRadioGroup>
        </div>

        <NSpace style="margin-top: 12px" align="center">
          <NButton type="primary" size="small" :loading="busy[row.review.id] === 'approved'" :disabled="!!busy[row.review.id] || !ready(row.review)" @click="decide(row, 'approved')">
            {{ row.review.conflicts.length ? 'Resolve' : 'Approve' }}{{ applyAfter ? ' & apply' : '' }}
          </NButton>
          <NButton type="error" size="small" secondary :loading="busy[row.review.id] === 'rejected'" :disabled="!!busy[row.review.id]" @click="decide(row, 'rejected')">Reject</NButton>
          <span v-if="!ready(row.review)" class="muted" style="font-size: 12px">Choose a side for every conflict.</span>
        </NSpace>
      </div>

      <template v-if="decidedReviews.length">
        <div class="muted section" style="margin-top: 18px">Decided</div>
        <NDataTable :columns="historyColumns" :data="decidedReviews" size="small" :bordered="false" :scroll-x="700" />
      </template>
    </NCard>
    <p class="muted legend">Legend: <AuthorityTag authority="proposed-decision" /> agent proposal · <AuthorityTag authority="accepted-decision" /> human-reviewed, on main</p>
  </div>
</template>

<style scoped>
.approval { border: 1px solid #e5c89055; border-radius: 6px; padding: 12px; background: #2b2e3f; }
.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.spacer { flex: 1; }
.cmd { margin: 10px 0 8px; max-height: 120px; color: #e5c890; }
.urgent { color: #e78284; font-weight: 600; }
.review { border-top: 1px solid #414559; padding: 14px 0; }
.review:first-of-type { border-top: none; }
.section { font-size: 12px; margin: 6px 0 8px; }
.conflict { margin-top: 10px; }
.choice { display: flex; flex-direction: column; gap: 8px; cursor: pointer; }
.legend { font-size: 12px; margin-top: 12px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
</style>
