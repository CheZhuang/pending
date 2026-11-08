<script setup>
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { NAlert, NButton, NCard, NEmpty, NSpin, NTag, useDialog, useNotification } from 'naive-ui';
import { api } from '../api/index.js';
import { describe } from '../api/errors.js';
import { useData } from '../useData.js';
import { short } from '../format.js';

const notify = useNotification();
const dialog = useDialog();
const { data, error, loading, reload } = useData(() => api.discoveredAgents(), () => []);
const agents = computed(() => data.value?.agents ?? []);
const operations = computed(() => data.value?.operations ?? {});

const runtimeName = runtime => ({ 'claude-code': 'Claude Code', claude: 'Claude Code', codex: 'Codex', 'codex-app-server': 'Codex' }[runtime] ?? runtime ?? 'Unknown runtime');
const connectionLabel = agent => agent.session?.id ? 'Agentree managed' : 'Discovered · unmanaged';
const dateLabel = value => value ? new Date(value).toLocaleString() : null;
function processDescription(agent) {
  if (!agent.process) return 'Process details unavailable';
  const pieces = [];
  if (agent.process.pid != null) pieces.push(`PID ${agent.process.pid}`);
  if (agent.process.executable) pieces.push(agent.process.executable);
  if (agent.process.startedAt) pieces.push(`started ${dateLabel(agent.process.startedAt)}`);
  if (agent.process.exitCode != null) pieces.push(`exit ${agent.process.exitCode}`);
  return pieces.join(' · ') || 'Process details unavailable';
}
function associationLabel(workspace) {
  if (!workspace?.name) return 'Workspace unavailable';
  return workspace.association === 'inferred-cwd' ? `${workspace.name} · matched from working directory` : workspace.name;
}
async function refresh() {
  try { await api.refreshDiscovery(); await reload(); }
  catch (e) { notify.error({ title: describe(e).title, content: describe(e).hint }); }
}
async function start(runtime) {
  try { await api.startManagedAgent(runtime); await reload(); }
  catch (e) { notify.error({ title: describe(e).title, content: describe(e).hint }); }
}
function stop(agent) {
  dialog.warning({ title: `Stop ${runtimeName(agent.runtime)}?`, content: 'Request termination of this Agentree-managed session?', positiveText: 'Stop session', negativeText: 'Cancel', onPositiveClick: async () => {
    try { await api.killSession(agent.session.id); await reload(); }
    catch (e) { notify.error({ title: describe(e).title, content: describe(e).hint }); }
  } });
}
</script>

<template>
  <main class="page">
    <div class="heading">
      <div>
        <h1 class="page-title">Local agents</h1>
        <p class="page-sub">Native processes found on this computer. Discovery alone does not give Agentree control of a session.</p>
      </div>
      <NButton secondary :loading="loading" @click="refresh">Refresh discovery</NButton>
    </div>

    <NAlert v-if="error" type="error" :title="describe(error).title" class="notice">
      {{ describe(error).hint }}
      <template #action><NButton size="small" @click="reload">Retry</NButton></template>
    </NAlert>
    <div v-else-if="loading && !data" class="center"><NSpin size="large" /></div>
    <template v-else>
      <NAlert v-if="data?.source === 'session-registry'" type="info" class="notice">Native process discovery is not available on this Gateway yet. Showing registered Agentree sessions only; unmanaged processes and live process metadata are unavailable.</NAlert>
      <div class="refresh-line muted">Last discovery refresh: {{ dateLabel(data?.refreshedAt) ?? 'not reported' }}</div>
      <NEmpty v-if="!agents.length" description="No Claude Code or Codex agents detected" class="empty" />
      <section v-else class="agent-list">
        <NCard v-for="agent in agents" :key="agent.id" size="small" class="agent-card">
          <div class="agent-head">
            <div>
              <div class="agent-title">{{ runtimeName(agent.runtime) }} <span class="muted mono">{{ short(agent.id) }}</span></div>
              <div class="meta">{{ processDescription(agent) }}</div>
            </div>
            <div class="tags">
              <NTag size="small" :type="agent.session?.id ? 'success' : 'warning'" :bordered="false">{{ connectionLabel(agent) }}</NTag>
              <NTag size="small" :type="agent.status === 'running' ? 'success' : 'default'" :bordered="false">{{ agent.status ?? 'status unavailable' }}</NTag>
            </div>
          </div>

          <div class="details">
            <div><span class="label">Working directory</span><span class="mono path">{{ agent.cwd ?? 'Unavailable' }}</span></div>
            <div><span class="label">Workspace</span><span>{{ associationLabel(agent.workspace) }}</span></div>
            <div><span class="label">Recent activity</span><span>{{ agent.activity?.summary ?? 'No activity observed' }}<small v-if="agent.activity?.evidence" class="evidence">{{ agent.activity.evidence }}<template v-if="agent.activity.observedAt"> · {{ dateLabel(agent.activity.observedAt) }}</template></small></span></div>
          </div>

          <div class="capabilities">
            <span class="label">Available through Agentree</span>
            <NTag v-if="agent.capabilities?.canInspectActivity" size="small" type="info">Inspect activity</NTag>
            <NTag v-if="agent.capabilities?.canDispatchTasks" size="small" type="info">Dispatch tasks</NTag>
            <NTag v-if="agent.capabilities?.canReviewApprovals" size="small" type="info">Review approvals</NTag>
            <NTag v-if="agent.capabilities?.canStop" size="small" type="info">Stop session</NTag>
            <span v-if="!agent.capabilities || !Object.values(agent.capabilities).some(Boolean)" class="muted">No session controls available</span>
          </div>

          <div v-if="agent.session?.id" class="actions">
            <RouterLink to="/main"><NButton size="tiny" secondary>Main</NButton></RouterLink>
            <RouterLink v-if="agent.capabilities?.canDispatchTasks" to="/tasks"><NButton size="tiny" secondary>Tasks</NButton></RouterLink>
            <RouterLink to="/conflicts"><NButton size="tiny" secondary>Conflicts</NButton></RouterLink>
            <RouterLink v-if="agent.capabilities?.canReviewApprovals" to="/approvals"><NButton size="tiny" secondary>Approvals</NButton></RouterLink>
            <RouterLink v-if="agent.capabilities?.canInspectActivity" to="/activity"><NButton size="tiny" secondary>Activity</NButton></RouterLink>
            <NButton v-if="agent.capabilities?.canStop" size="tiny" type="error" secondary @click="stop(agent)">Stop session</NButton>
          </div>
        </NCard>
      </section>
      <div v-if="operations.canStartManagedAgent" class="start-row">
        <span class="muted">Start a new managed session</span>
        <NButton size="small" @click="start('codex-app-server')">Start managed Codex</NButton>
        <NButton size="small" @click="start('claude-code')">Start managed Claude Code</NButton>
      </div>
    </template>
  </main>
</template>

<style scoped>
.heading { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
.heading .page-title { margin-bottom:4px; }
.notice { margin:12px 0; }
.refresh-line { font-size:12px; margin:8px 0 14px; }
.agent-list { display:grid; gap:10px; }
.agent-head { display:flex; justify-content:space-between; align-items:flex-start; gap:14px; }
.agent-title { font-size:15px; font-weight:650; }
.meta { margin-top:4px; font-size:12px; color:#a5adce; }
.tags { display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; }
.details { display:grid; grid-template-columns:minmax(180px, 1fr) minmax(180px, .8fr) minmax(220px, 1.3fr); gap:14px; margin-top:14px; font-size:12px; }
.details > div { min-width:0; display:flex; flex-direction:column; gap:4px; }
.label { color:#a5adce; font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
.path { overflow-wrap:anywhere; }
.evidence { display:block; color:#a5adce; margin-top:3px; }
.capabilities { display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-top:13px; }
.capabilities .label { margin-right:4px; }
.actions { display:flex; gap:6px; flex-wrap:wrap; margin-top:12px; padding-top:10px; border-top:1px solid #414559; }
.actions a { text-decoration:none; }
.start-row { display:flex; align-items:center; gap:8px; margin-top:18px; flex-wrap:wrap; }
.empty { padding:56px 0; }
.center { display:flex; justify-content:center; padding:60px; }
@media(max-width:760px) { .agent-head { flex-direction:column; } .tags { justify-content:flex-start; } .details { grid-template-columns:1fr; } }
</style>
