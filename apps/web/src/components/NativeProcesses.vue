<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { NAlert, NButton, NCard, NDataTable } from 'naive-ui';
import { api } from '../api/index.js';

const inventory = ref(null);
const error = ref('');
const loading = ref(false);
let timer;
let disposed = false;
const columns = [
  { title:'Runtime', key:'runtime' },
  { title:'PID', key:'pid' },
  { title:'Executable', key:'executable', render:p => p.executable ?? 'Unavailable' },
  { title:'Working directory', key:'cwd', render:p => p.cwd ?? 'Unavailable' },
  { title:'Observation', key:'nativeObservation', render:p => p.managedSessionId ? `Managed session ${p.managedSessionId}` : 'Process metadata only' },
  { title:'Identification', key:'evidence', render:p => `${p.evidence}${p.identityReliable ? '' : ' · start time unavailable'}` },
];
async function load(refresh = false) {
  if (loading.value) return;
  loading.value = true;
  try {
    const next = await (refresh ? api.refreshProcesses() : api.processes());
    if (!disposed) { inventory.value = next; error.value = ''; }
  } catch { if (!disposed) { inventory.value = null; error.value = 'Local process discovery is unavailable.'; } }
  finally { loading.value = false; }
}
onMounted(() => { void load(); timer = setInterval(() => { void load(); }, 5000); });
onBeforeUnmount(() => { disposed = true; clearInterval(timer); });
</script>

<template>
  <div class="processes">
    <NCard title="Local coding agents" size="small">
      <template #header-extra><NButton size="small" :loading="loading" @click="load(true)">Refresh processes</NButton></template>
      <p class="muted">Agents running on this computer. Discovery provides process metadata; managed session controls remain in the workspace.</p>
      <NAlert v-if="error || inventory?.status === 'unavailable'" type="warning">{{ error || inventory.message }}</NAlert>
      <NDataTable :columns="columns" :data="inventory?.processes ?? []" :bordered="false" size="small" :scroll-x="800" :row-key="p => p.id" />
      <small v-if="inventory?.scannedAt" class="muted">Last scan: {{ inventory.scannedAt }}</small>
    </NCard>
  </div>
</template>

<style scoped>.processes { margin:16px 24px; } p { margin:0 0 12px; font-size:13px; }</style>
