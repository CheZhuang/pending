<!-- App layout: navigation, workspace picker, live connection state, and mock/live switch. -->
<script setup>
import { computed, h, onMounted, ref, watch } from 'vue';
import { RouterLink, RouterView, useRoute } from 'vue-router';
import {
  NAlert, NBadge, NButton, NDropdown, NLayout, NLayoutContent, NLayoutHeader, NLayoutSider, NMenu, NSelect, NSpin, NTag,
} from 'naive-ui';
import { switchMode } from '../api/index.js';
import { describe } from '../api/errors.js';
import { boot, selectWorkspace, state } from '../state.js';
import { frappe } from '../theme.js';
import PendingTreeLogo from './PendingTreeLogo.vue';

const route = useRoute();
const showModeSelector = import.meta.env.DEV;
const narrow = () => window.innerWidth < 900;
const collapsed = ref(narrow());
// Collapse the menu on narrow screens, and after navigating there.
window.addEventListener('resize', () => { if (narrow()) collapsed.value = true; });
watch(() => route.fullPath, () => { if (narrow()) collapsed.value = true; });

const menu = computed(() => [
    { key: 'overview', label: () => h(RouterLink, { to: '/overview' }, () => 'Overview') },
    { key: 'main', label: () => h(RouterLink, { to: '/main' }, () => 'Main') },
    { key: 'branches', label: () => h(RouterLink, { to: '/branches' }, () => 'Branches') },
    { key: 'conflicts', label: () => h(RouterLink, { to: '/conflicts' }, () => 'Conflicts') },
    { key: 'tasks', label: () => h(RouterLink, { to: '/tasks' }, () => 'Tasks') },
    { key: 'activity', label: () => h(RouterLink, { to: '/activity' }, () => 'Activity') },
    { key: 'approvals', label: () => h(RouterLink, { to: '/approvals' }, () => 'Approvals') },
]);

const workspaceOptions = computed(() => state.workspaces.map((w) => ({ label: w.name, value: w.id })));

const connection = computed(() => ({
  idle: { text: 'Not connected', color: frappe.overlay1 },
  connecting: { text: 'Connecting…', color: frappe.yellow },
  live: { text: 'Live', color: frappe.green },
  reconnecting: { text: 'Reconnecting…', color: frappe.peach },
  closed: { text: 'Stream closed', color: frappe.red },
}[state.connection]));

const modeOptions = [
  { label: 'Mock data (in-browser)', key: 'mock' },
  { label: 'Live gateway', key: 'live' },
];

const fatal = computed(() => (state.fatal ? describe(state.fatal) : null));

onMounted(boot);
</script>

<template>
  <NLayout has-sider style="height: 100vh">
    <NLayoutSider
      bordered collapse-mode="width" :collapsed-width="0" :width="188" :collapsed="collapsed"
      show-trigger="bar" @collapse="collapsed = true" @expand="collapsed = false"
    >
      <div class="brand">
        <PendingTreeLogo :size="30" />
      </div>
      <NMenu :value="route.meta.menu ?? route.name" :options="menu" />
      <div v-if="!collapsed" class="sider-foot muted">
        <div>{{ state.mode === 'mock' ? 'Mock gateway' : state.baseUrl }}</div>
      </div>
    </NLayoutSider>

    <NLayout>
      <NLayoutHeader bordered class="header">
        <NSelect
          class="ws-select" size="small" placeholder="No workspace"
          :options="workspaceOptions" :value="state.workspaceId" @update:value="selectWorkspace"
        />
        <div class="spacer" />
        <span class="conn">
          <NBadge dot :color="connection.color" />
          <span class="conn-text">{{ connection.text }}</span>
          <span v-if="state.lastSeq" class="muted mono">#{{ state.lastSeq }}</span>
        </span>
        <NDropdown v-if="showModeSelector" trigger="click" :options="modeOptions" @select="switchMode">
          <NTag :type="state.mode === 'mock' ? 'warning' : 'success'" size="small" round class="mode-tag">
            {{ state.mode === 'mock' ? 'MOCK' : 'LIVE' }} ▾
          </NTag>
        </NDropdown>
      </NLayoutHeader>

      <NLayoutContent :native-scrollbar="false" content-style="min-height: calc(100vh - 53px)">
        <NAlert v-if="fatal" type="error" :title="fatal.title" class="banner">
          {{ fatal.hint }}
          <template #action><NButton size="small" @click="boot">Retry</NButton></template>
        </NAlert>
        <div v-if="state.loading && !state.workspaces.length" class="center"><NSpin /></div>
        <RouterView v-else-if="route.name === 'overview' || state.workspaceId" />
        <div v-else class="page">
          <h1 class="page-title">Choose or create a workspace</h1>
          <p class="page-sub">Local agent discovery is available in Overview. Select a workspace to use Main, Tasks, Conflicts, and Approvals.</p>
          <RouterLink to="/overview">Back to local agents</RouterLink>
        </div>
      </NLayoutContent>
    </NLayout>
  </NLayout>
</template>

<style scoped>
.brand { display: flex; align-items: center; gap: 10px; padding: 16px 18px 12px; font-weight: 700; font-size: 16px; color: #c6d0f5; }
.sider-foot { position: absolute; bottom: 14px; left: 18px; right: 12px; font-size: 11.5px; word-break: break-all; }
.header { height: 52px; display: flex; align-items: center; gap: 14px; padding: 0 18px; }
.ws-select { width: 200px; }
.spacer { flex: 1; }
.conn { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; }
.mode-tag { cursor: pointer; }
.banner { margin: 16px 24px 0; }
.center { display: flex; justify-content: center; padding: 80px 0; }
@media (max-width: 640px) {
  .header { gap: 10px; padding: 0 12px 0 16px; }
  .ws-select { width: 140px; }
  .conn .mono, .conn-text { display: none; }
}
</style>
