<!-- Overview: local coding agents. Managed sessions (with the controls PendingTree really
     has for them) and processes the Gateway merely discovered on this computer.
     Works without a selected workspace; discovery is computer-wide. -->
<script setup>
import { computed, h, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { NAlert, NButton, NCard, NDataTable, NEmpty, NSpin, NTag, NTooltip, useDialog, useNotification } from 'naive-ui';
import { api } from '../api/index.js';
import { describe, errorText } from '../api/errors.js';
import { refreshWorkspaces, selectWorkspace, state } from '../state.js';
import { useData } from '../useData.js';
import { dateTime, short } from '../format.js';
import { EVIDENCE_TEXT, buildAgentRows, processLine, runtimeName } from '../discovery.js';

const notify = useNotification();
const dialog = useDialog();
const router = useRouter();

// Sessions and the inventory fail independently: a broken process scan must not hide managed sessions.
const { data, error, loading, reload } = useData(async () => {
  const [inventory, sessions] = await Promise.allSettled([api.processes(), api.sessions()]);
  if (inventory.status === 'rejected' && sessions.status === 'rejected') throw sessions.reason;
  return {
    inventory: inventory.status === 'fulfilled' ? inventory.value : null,
    inventoryError: inventory.status === 'rejected' ? inventory.reason : null,
    sessions: sessions.status === 'fulfilled' ? sessions.value : [],
    sessionsError: sessions.status === 'rejected' ? sessions.reason : null,
  };
}, () => [state.changed.sessions], { workspaceScoped: false });

const rows = computed(() => buildAgentRows({ inventory: data.value?.inventory, sessions: data.value?.sessions ?? [], workspaces: state.workspaces }));
const inventory = computed(() => data.value?.inventory ?? null);
// A session in a workspace the Console has not listed yet (e.g. created by a demo after the page opened).
watch(() => rows.value.unknownWorkspaceIds.join(','), (ids) => { if (ids) void refreshWorkspaces(); });

// GET /v1/processes returns the Gateway's cached scan (it rescans every 5 s itself),
// so polling it is cheap. Poll only while this page is open and visible.
const POLL_MS = 10_000;
let timer = null;
const tick = () => { if (document.visibilityState === 'visible') void reload(); };
onMounted(() => { timer = setInterval(tick, POLL_MS); });
onBeforeUnmount(() => clearInterval(timer));

const refreshing = ref(false);
async function rescan() {
  refreshing.value = true;
  try { await api.refreshProcesses(); await reload(); }
  catch (e) { notify.error({ title: 'Process scan failed', content: errorText(e) }); }
  finally { refreshing.value = false; }
}

function stop(row) {
  dialog.warning({
    title: `Stop ${row.title}?`,
    content: 'PendingTree asks the launcher to terminate this managed session. Pending approvals are denied and unfinished tasks end without a native outcome. This cannot be undone.',
    positiveText: 'Stop session', negativeText: 'Cancel',
    onPositiveClick: async () => {
      try {
        const result = await api.killSession(row.session.id);
        notify.info({ title: 'Stop requested', content: `Session is ${result.state}. The exit appears once the launcher reports it.`, duration: 6000 });
      } catch (e) { notify.error({ title: 'Stop failed', content: errorText(e) }); }
      finally { void reload(); }
    },
  });
}

/** Open a workspace page for this session, switching workspace first when needed. */
async function open(row, path, query) {
  if (row.workspace?.id && row.workspace.id !== state.workspaceId) await selectWorkspace(row.workspace.id);
  router.push({ path, query });
}

const lifecycle = (s) => ({ active: 'success', 'kill-requested': 'warning' }[s.state] ?? 'default');
const capabilityList = (row) => [
  ['Tasks', row.capabilities.tasks],
  ['Approvals', row.capabilities.approvals],
  ['Stop', row.capabilities.stop],
];

const unmanagedColumns = [
  { title: 'Runtime', key: 'runtime', width: 110, render: (r) => runtimeName(r.runtime) },
  { title: 'PID', key: 'pid', width: 80, render: (r) => h('span', { class: 'mono' }, r.process.pid) },
  { title: 'Working directory', key: 'cwd', ellipsis: { tooltip: true }, render: (r) => h('span', { class: r.process.cwd ? 'mono' : 'muted' }, r.process.cwd ?? 'Unavailable on this platform or permission') },
  { title: 'Executable', key: 'executable', ellipsis: { tooltip: true }, render: (r) => h('span', { class: r.process.executable ? 'mono' : 'muted' }, r.process.executable ?? 'Unavailable') },
  { title: 'Identified by', key: 'evidence', width: 210, render: (r) => `${EVIDENCE_TEXT[r.process.evidence] ?? r.process.evidence}${r.process.identityReliable ? '' : ' · no start time'}` },
];
</script>

<template>
  <div class="page">
    <div class="heading">
      <div>
        <h1 class="page-title">Local agents</h1>
        <p class="page-sub">Claude Code and Codex on this computer. Only managed sessions can be supervised; a discovered process is metadata only.</p>
      </div>
      <NButton secondary size="small" :loading="refreshing" @click="rescan">Scan processes now</NButton>
    </div>

    <NAlert v-if="error" type="error" :title="describe(error).title" class="notice">
      {{ describe(error).hint }}
      <template #action><NButton size="small" @click="reload">Retry</NButton></template>
    </NAlert>
    <div v-else-if="!data" class="center"><NSpin size="large" /></div>
    <template v-else>
      <div class="scan-line muted">
        <template v-if="data.inventoryError">Process discovery: {{ describe(data.inventoryError).title }}</template>
        <template v-else-if="inventory?.status === 'initializing'">Process discovery: first scan in progress…</template>
        <template v-else>Process scan: {{ inventory?.scannedAt ? dateTime(inventory.scannedAt) : 'not reported' }} · refreshes every few seconds</template>
        <NSpin v-if="loading" size="small" style="margin-left: 8px" />
      </div>
      <NAlert v-if="inventory?.status === 'unavailable'" type="warning" class="notice" title="Process discovery unavailable">{{ inventory.message ?? 'The Gateway could not enumerate local processes.' }} Managed sessions are still listed.</NAlert>
      <NAlert v-if="data.sessionsError" type="error" class="notice" :title="describe(data.sessionsError).title">Managed sessions could not be loaded. {{ describe(data.sessionsError).hint }}</NAlert>

      <h2 class="section">Managed sessions <span class="muted count">{{ rows.managed.length }}</span></h2>
      <NEmpty v-if="!rows.managed.length" class="empty" description="No managed session is running. Start Claude Code or Codex through a PendingTree launcher to supervise it." />
      <div class="agent-list">
        <NCard v-for="row in rows.managed" :key="row.key" size="small">
          <div class="agent-head">
            <div>
              <div class="agent-title">{{ row.title }} <span class="muted mono">{{ row.session.runtime }} · {{ short(row.session.id) }}</span></div>
              <div class="meta">{{ processLine(row.process) }}</div>
              <div v-if="!row.process && row.reportedProcess" class="meta">Launcher reported PID {{ row.reportedProcess.pid }}</div>
            </div>
            <div class="tags">
              <NTag size="small" type="info" :bordered="false">PendingTree managed</NTag>
              <NTag size="small" :type="lifecycle(row.session)" :bordered="false">{{ row.session.state }}</NTag>
            </div>
          </div>
          <div class="details">
            <div><span class="label">Workspace</span><span>{{ row.workspace.name ?? 'Not listed yet' }}<span v-if="row.workspace.id === state.workspaceId" class="muted"> · selected</span></span></div>
            <div><span class="label">Working directory</span><span :class="row.process?.cwd ? 'mono path' : 'muted'">{{ row.process?.cwd ?? 'Not reported' }}</span></div>
            <div><span class="label">Process exit</span><span>{{ row.session.processStatus === 'exit-reported' ? 'Exit reported by launcher' : 'No exit reported' }}</span></div>
          </div>
          <div class="capabilities">
            <span class="label">Through PendingTree</span>
            <NTooltip v-for="[name, cap] in capabilityList(row)" :key="name">
              <template #trigger><NTag size="small" :type="cap.available ? 'success' : 'default'" :bordered="false">{{ cap.available ? '✓' : '✕' }} {{ name }}</NTag></template>
              {{ cap.note }}
            </NTooltip>
          </div>
          <div class="actions">
            <NButton size="tiny" secondary @click="open(row, '/activity', { session: row.session.id })">Activity</NButton>
            <NButton v-if="row.capabilities.tasks.available" size="tiny" secondary @click="open(row, '/tasks', { session: row.session.id })">Dispatch task</NButton>
            <NButton v-if="row.capabilities.approvals.available" size="tiny" secondary @click="open(row, '/approvals')">Approvals</NButton>
            <NButton size="tiny" secondary @click="open(row, '/branches')">Branch work</NButton>
            <span class="spacer" />
            <NButton v-if="row.capabilities.stop.available" size="tiny" type="error" secondary @click="stop(row)">Stop session</NButton>
          </div>
        </NCard>
      </div>

      <h2 class="section">Discovered, not managed <span class="muted count">{{ rows.unmanaged.length }}</span></h2>
      <p class="muted note">Found in the OS process list by name or path. PendingTree cannot dispatch tasks to, review approvals for, or stop these processes, and does not observe their activity.</p>
      <NCard size="small">
        <NDataTable :columns="unmanagedColumns" :data="rows.unmanaged" :row-key="(r) => r.key" size="small" :bordered="false" :scroll-x="820">
          <template #empty><NEmpty size="small" :description="inventory?.status === 'ok' ? 'No other Claude Code or Codex processes found.' : 'No process inventory available.'" /></template>
        </NDataTable>
      </NCard>

      <details v-if="rows.ended.length" class="ended">
        <summary class="muted">{{ rows.ended.length }} ended session{{ rows.ended.length === 1 ? '' : 's' }}</summary>
        <div v-for="s in rows.ended" :key="s.id" class="ended-line"><span>{{ s.label || runtimeName(s.runtime) }}</span><span class="mono muted">{{ s.runtime }} · {{ short(s.id) }}</span><span class="muted">{{ s.processStatus === 'exit-reported' ? 'exit reported' : 'exit not reported' }}</span></div>
      </details>
    </template>
  </div>
</template>

<style scoped>
.heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.heading .page-title { margin-bottom: 4px; }
.notice { margin: 10px 0; }
.scan-line { display: flex; align-items: center; font-size: 12px; margin: 0 0 6px; }
.section { font-size: 15px; margin: 18px 0 10px; }
.count { font-weight: 400; font-size: 13px; margin-left: 4px; }
.note { font-size: 12px; margin: -4px 0 10px; }
.agent-list { display: grid; gap: 10px; }
.agent-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 14px; }
.agent-title { font-size: 15px; font-weight: 650; }
.meta { margin-top: 4px; font-size: 12px; color: #a5adce; }
.tags { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.details { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-top: 12px; font-size: 12px; }
.details > div { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.label { color: #a5adce; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
.path { overflow-wrap: anywhere; }
.capabilities { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 12px; }
.capabilities .label { margin-right: 4px; }
.actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 12px; padding-top: 10px; border-top: 1px solid #414559; }
.spacer { flex: 1; }
.empty { padding: 24px 0; }
.center { display: flex; justify-content: center; padding: 60px; }
.ended { margin-top: 18px; font-size: 13px; }
.ended summary { cursor: pointer; }
.ended-line { display: flex; gap: 12px; flex-wrap: wrap; padding: 6px 0; border-bottom: 1px solid #414559; }
@media (max-width: 760px) { .heading, .agent-head { flex-direction: column; } .tags { justify-content: flex-start; } .details { grid-template-columns: 1fr; } }
</style>
