<!-- Tasks: send a human instruction to one managed agent session through the Gateway,
     and follow its status as reported by the Gateway from native evidence. This is a
     dispatch form and a status list, not a planner: one task, one session. -->
<script setup>
import { computed, h, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  NAlert, NButton, NCard, NCheckbox, NDataTable, NDescriptions, NDescriptionsItem, NDrawer, NDrawerContent,
  NEmpty, NInput, NSelect, NSpace, NTag, NTimeline, NTimelineItem, NTooltip, useDialog, useMessage,
} from 'naive-ui';
import { api } from '../api/index.js';
import { describe, errorText } from '../api/errors.js';
import { loadOlder, state } from '../state.js';
import { useData } from '../useData.js';
import { clip, dateTime, eventSummary, short, time } from '../format.js';
import { sessionLabel } from '../model.js';
import { CANCELLABLE, composeInstructions, deliveryOf, statusInfo, taskEvidence } from '../task-status.js';

const message = useMessage();
const dialog = useDialog();
const route = useRoute();
const router = useRouter();

const { data, error, reload } = useData(async () => {
  const [sessions, tasks] = await Promise.all([api.sessions(), api.tasks()]);
  const mine = sessions.filter((s) => s.workspaceId === state.workspaceId);
  const ids = new Set(mine.map((s) => s.id));
  return { sessions: mine, tasks: tasks.filter((t) => ids.has(t.sessionId)) };
}, () => [state.workspaceId, state.changed.tasks, state.changed.sessions]);
const sessionById = computed(() => new Map((data.value?.sessions ?? []).map((s) => [s.id, s])));

// ---- submit form
const sessionId = ref(typeof route.query.session === 'string' ? route.query.session : null);
const instructions = ref('');
const context = ref('');
const includeMain = ref(true);
const submitting = ref(false);
// One requestId per distinct submission: a retry after a lost response reuses it,
// so the Gateway returns the original task instead of creating a duplicate.
let pending = null;
const sessionOptions = computed(() => (data.value?.sessions ?? []).map((s) => {
  const d = deliveryOf(s);
  // Labelled sessions get their runtime appended; unlabelled ones already show it.
  return { value: s.id, label: `${sessionLabel(s)}${s.label ? ` · ${s.runtime}` : ''}${d.ok ? '' : ' · cannot receive tasks'}`, session: s };
}));
const chosen = computed(() => sessionById.value.get(sessionId.value));
const delivery = computed(() => deliveryOf(chosen.value));
const finalText = computed(() => composeInstructions(instructions.value, context.value));
watch([sessionId, finalText, includeMain], () => { pending = null; });

async function submit() {
  if (!chosen.value || !instructions.value.trim()) return;
  const body = { sessionId: sessionId.value, instructions: finalText.value, includeMain: includeMain.value };
  pending ??= { ...body, requestId: crypto.randomUUID() };
  submitting.value = true;
  try {
    const task = await api.submitTask(pending);
    pending = null;
    instructions.value = ''; context.value = '';
    const info = statusInfo(task.status);
    if (task.status === 'delivery-unavailable') message.warning(`Recorded but not deliverable: ${task.reason ?? info.meaning}`, { duration: 8000 });
    else message.success(`Task ${short(task.id)} submitted · ${info.label}`);
    await reload();
    openTask(task);
  } catch (e) {
    const d = describe(e);
    message.error(`${d.title}${d.hint ? ` — ${d.hint}` : ''}${e?.code === 'NETWORK' ? ' Submitting again reuses the same request id.' : ''}`, { duration: 8000 });
  } finally { submitting.value = false; }
}

// ---- list and detail
const selectedId = ref(null);
const selected = computed(() => data.value?.tasks.find((t) => t.id === selectedId.value) ?? null);
const openTask = (task) => { selectedId.value = task.id; };
const evidence = computed(() => (selected.value ? taskEvidence(selected.value, state.events) : []));
const cancelling = ref(null);
// Interrupting a running native turn cannot be undone; a not-yet-delivered task just never starts.
function cancel(task) {
  const delivered = task.status !== 'submitted';
  dialog.warning({
    title: delivered ? 'Interrupt this task?' : 'Cancel this task?',
    content: delivered
      ? 'PendingTree asks the runner to interrupt the native turn. Work already done by the agent is not undone, and the final status waits for native evidence.'
      : 'The task has not been delivered yet; it will not be sent to the agent.',
    positiveText: delivered ? 'Interrupt' : 'Cancel task', negativeText: 'Keep it',
    onPositiveClick: () => doCancel(task),
  });
}
async function doCancel(task) {
  cancelling.value = task.id;
  try {
    const result = await api.cancelTask(task.id);
    message.info(`Cancel requested · now ${statusInfo(result.status).label}. Final status waits for native evidence.`);
    await reload();
  } catch (e) { message.error(errorText(e), { duration: 7000 }); await reload(); }
  finally { cancelling.value = null; }
}
const toActivity = (task) => router.push({ path: '/activity', query: { session: task.sessionId } });

const statusTag = (task) => {
  const info = statusInfo(task.status);
  return h(NTooltip, null, { trigger: () => h(NTag, { size: 'small', type: info.tone, bordered: false }, () => info.label), default: () => info.meaning });
};
const columns = [
  { title: 'Submitted', key: 'submittedAt', width: 92, render: (t) => h('span', { class: 'mono' }, time(t.submittedAt)) },
  { title: 'Agent', key: 'session', width: 170, ellipsis: { tooltip: true }, render: (t) => sessionLabel(sessionById.value.get(t.sessionId)) },
  { title: 'Instructions', key: 'instructions', ellipsis: { tooltip: true }, render: (t) => clip(t.instructions, 90) },
  { title: 'Status', key: 'status', width: 140, render: statusTag },
  { title: 'Native turn', key: 'nativeTurnId', width: 120, render: (t) => h('span', { class: 'mono muted' }, t.nativeTurnId ? short(t.nativeTurnId) : '—') },
  {
    title: '', key: 'actions', width: 170, align: 'right',
    render: (t) => h(NSpace, { size: 4, justify: 'end' }, () => [
      CANCELLABLE.has(t.status) ? h(NButton, { size: 'tiny', type: 'error', secondary: true, loading: cancelling.value === t.id, onClick: (e) => { e.stopPropagation(); cancel(t); } }, () => 'Cancel') : null,
      h(NButton, { size: 'tiny', secondary: true, onClick: (e) => { e.stopPropagation(); toActivity(t); } }, () => 'Activity'),
    ]),
  },
];
const rowProps = (t) => ({ style: 'cursor: pointer', onClick: () => openTask(t) });
</script>

<template>
  <div class="page">
    <h1 class="page-title">Tasks</h1>
    <p class="page-sub">Send an instruction to one managed agent session. Statuses come from the Gateway and change only on native evidence; the agent still plans and executes the work itself.</p>
    <NAlert v-if="error" type="error" :title="describe(error).title" style="margin-bottom: 12px">{{ describe(error).hint }}</NAlert>

    <NCard title="New task" size="small" style="margin-bottom: 16px">
      <NSelect v-model:value="sessionId" :options="sessionOptions" placeholder="Choose an agent session" size="small" filterable clearable />
      <NAlert v-if="chosen" :type="delivery.ok ? 'success' : 'warning'" :show-icon="false" style="margin-top: 8px; font-size: 12.5px">{{ delivery.reason }}</NAlert>
      <NInput v-model:value="instructions" type="textarea" :autosize="{ minRows: 3, maxRows: 8 }" placeholder="Instructions for the agent…" style="margin-top: 8px" />
      <NInput v-model:value="context" type="textarea" :autosize="{ minRows: 1, maxRows: 4 }" placeholder="Optional context (appended under “Context from the human supervisor”)" style="margin-top: 8px" />
      <NSpace justify="space-between" align="center" style="margin-top: 8px">
        <NCheckbox v-model:checked="includeMain" size="small">Attach current Main (snapshot taken at submission)</NCheckbox>
        <NButton type="primary" size="small" :loading="submitting" :disabled="!chosen || !instructions.trim()" @click="submit">
          {{ chosen && !delivery.ok ? 'Record anyway' : 'Submit task' }}
        </NButton>
      </NSpace>
    </NCard>

    <NCard title="Tasks" size="small">
      <NDataTable :columns="columns" :data="data?.tasks ?? []" :row-key="(t) => t.id" :row-props="rowProps" size="small" :bordered="false" :scroll-x="860" :loading="!data && !error">
        <template #empty><NEmpty size="small" :description="data ? 'No tasks dispatched in this workspace yet.' : 'Loading tasks…'" /></template>
      </NDataTable>
    </NCard>

    <NDrawer :show="!!selected" :width="'min(600px, 100vw)'" @update:show="(v) => { if (!v) selectedId = null; }">
      <NDrawerContent v-if="selected" :title="`Task ${short(selected.id)}`" closable>
        <NSpace align="center" style="margin-bottom: 10px">
          <NTag :type="statusInfo(selected.status).tone" :bordered="false">{{ statusInfo(selected.status).label }}</NTag>
          <NButton v-if="CANCELLABLE.has(selected.status)" size="small" type="error" secondary :loading="cancelling === selected.id" @click="cancel(selected)">Cancel / interrupt</NButton>
          <NButton size="small" secondary @click="toActivity(selected)">Open agent activity</NButton>
        </NSpace>
        <p class="muted small" style="margin-top: 0">{{ statusInfo(selected.status).meaning }}</p>
        <NAlert v-if="selected.reason" type="warning" :show-icon="false" style="margin-bottom: 10px">{{ selected.reason }}</NAlert>
        <NDescriptions :column="1" label-placement="left" size="small" bordered>
          <NDescriptionsItem label="Agent">{{ sessionLabel(sessionById.get(selected.sessionId)) }} <span class="mono muted">{{ selected.runtime }}</span></NDescriptionsItem>
          <NDescriptionsItem label="Submitted">{{ dateTime(selected.submittedAt) }} by {{ selected.submittedBy }}</NDescriptionsItem>
          <NDescriptionsItem label="Updated">{{ dateTime(selected.updatedAt) }}</NDescriptionsItem>
          <NDescriptionsItem label="Native turn"><span class="mono">{{ selected.nativeTurnId ?? 'not accepted yet' }}</span></NDescriptionsItem>
          <NDescriptionsItem label="Request id"><span class="mono">{{ selected.requestId }}</span></NDescriptionsItem>
        </NDescriptions>
        <h4>Instructions</h4>
        <pre class="json mono">{{ selected.instructions }}</pre>
        <template v-if="selected.mainContext">
          <h4>Main snapshot attached (revision {{ selected.mainContext.revision }})</h4>
          <ul class="ctx"><li v-for="e in selected.mainContext.entries" :key="e.id">{{ e.body }}</li></ul>
        </template>
        <h4>Delivery evidence</h4>
        <p v-if="!evidence.length" class="muted small">No task records in the loaded activity yet.</p>
        <p v-if="state.history.hasOlder && Date.parse(selected.submittedAt) < Date.parse(state.events[0]?.occurredAt ?? '')" class="muted small">
          This task is older than the loaded activity window, so some evidence may not be shown.
          <NButton size="tiny" secondary :loading="state.history.loadingOlder" @click="loadOlder">Load older events</NButton>
        </p>
        <NTimeline v-else>
          <NTimelineItem v-for="e in evidence" :key="e.sequence" :type="e.mode === 'observed' ? 'info' : 'default'"
            :title="`${e.type} · ${e.mode === 'observed' ? 'native evidence' : 'Gateway record'}`" :time="`#${e.sequence} · ${time(e.occurredAt)}`">
            {{ eventSummary(e) }}
          </NTimelineItem>
        </NTimeline>
      </NDrawerContent>
    </NDrawer>
  </div>
</template>

<style scoped>
.small { font-size: 12px; }
h4 { margin: 16px 0 6px; }
.ctx { padding-left: 18px; margin: 0; font-size: 13px; line-height: 1.5; }
</style>
