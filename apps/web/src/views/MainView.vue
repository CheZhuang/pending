<script setup>
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NCard, NEmpty, NInput, NSpace, NTag, useMessage } from 'naive-ui';
import { api } from '../api/index.js';
import { describe } from '../api/errors.js';
import { state, workspace } from '../state.js';
import { useData } from '../useData.js';
import { actorText, dateTime, short } from '../format.js';
import { mainWriteTarget } from './main-write.js';

const message = useMessage();
const { data, error, reload } = useData(() => api.main(state.workspaceId), () => [state.workspaceId, state.changed.context]);
const body = ref('');
const filesText = ref('');
const busy = ref(false);
const historyId = ref(null);
const editingId = ref(null);
const editRevision = ref(null);
const editWorkspaceId = ref(null);
const history = ref([]);
const entries = computed(() => (data.value?.entries ?? []).filter((entry) => !entry.removed));
const removedEntries = computed(() => (data.value?.removedEntries ?? []).filter((entry) => entry.removed));
const roots = computed(() => workspace()?.roots ?? []);
function parseFiles() {
  const lines = filesText.value.split('\n').map(x => x.trim()).filter(Boolean);
  const parsed = [];
  for (const line of lines) {
    const x = line;
    const index = x.indexOf(':');
    if (index <= 0 || !roots.value.some(root => root.id === x.slice(0, index)) || !x.slice(index + 1).trim()) throw new Error(`Use a known rootId:path reference for “${x}”.`);
    parsed.push({ rootId: x.slice(0, index), path: x.slice(index + 1).trim() });
  }
  return parsed;
}
watch(() => state.workspaceId, () => { body.value = ''; filesText.value = ''; editingId.value = null; editRevision.value = null; editWorkspaceId.value = null; historyId.value = null; history.value = []; });
async function save(entry) {
  if (!body.value.trim()) return;
  busy.value = true;
  try {
    const files = parseFiles();
    const target = mainWriteTarget({ editingId: editingId.value, editRevision: editRevision.value, editWorkspaceId: editWorkspaceId.value, workspaceId: state.workspaceId, currentRevision: data.value.revision });
    entry = target.entryId ? { id: target.entryId } : null;
    const payload = { body: body.value, files, expectedRevision: target.expectedRevision };
    if (target.entryId) await api.updateMainEntry(state.workspaceId, target.entryId, payload);
    else await api.updateMain(state.workspaceId, payload);
    body.value = ''; filesText.value = ''; editingId.value = null; editRevision.value = null; editWorkspaceId.value = null; await reload(); message.success(entry ? 'Main entry updated' : 'Added to Main');
  } catch (e) { const d = describe(e); message.error(d.hint || d.title); } finally { busy.value = false; }
}
async function remove(entry) {
  busy.value = true;
  try { await api.updateMainEntry(state.workspaceId, entry.id, { body: entry.body, files: entry.files, expectedRevision: data.value.revision, remove: true }); await reload(); }
  catch (e) { message.error(describe(e).hint); } finally { busy.value = false; }
}
async function showHistory(entry) {
  const entryId = entry.id; const workspaceId = state.workspaceId;
  historyId.value = entryId; history.value = [];
  try {
    const result = await api.mainHistory(workspaceId, entryId);
    if (historyId.value === entryId && state.workspaceId === workspaceId) history.value = result;
  } catch (e) { if (historyId.value === entryId && state.workspaceId === workspaceId) message.error(describe(e).hint || describe(e).title); }
}
</script>

<template>
  <div class="page">
    <h1 class="page-title">Main</h1>
    <p class="page-sub">The shared, human-maintained text reference agents receive. Main never edits project source files.</p>
    <NAlert v-if="error" type="error" :title="describe(error).title">{{ describe(error).hint }}</NAlert>
    <NCard :title="editingId ? 'Edit Main entry' : 'Add to Main'" size="small" style="margin-bottom: 16px">
      <NInput v-model:value="body" type="textarea" :autosize="{ minRows: 3, maxRows: 8 }" placeholder="Write a project expectation, context, or accepted outcome for agents to use…" />
      <NInput v-model:value="filesText" type="textarea" :autosize="{ minRows: 1, maxRows: 3 }" :placeholder="`Related files, one per line (${roots.map(r => r.id).join(', ')}:path)`" style="margin-top: 8px" />
      <NSpace justify="end" style="margin-top: 8px"><NButton v-if="editingId" size="small" @click="editingId = null; editRevision = null; editWorkspaceId = null; body = ''; filesText = ''">Cancel edit</NButton><NButton type="primary" :disabled="!data || !body.trim()" :loading="busy" @click="save()">{{ editingId ? 'Save changes' : 'Add reference' }}</NButton></NSpace>
    </NCard>
    <NEmpty v-if="!entries.length" description="Main has no reference entries yet." />
    <NCard v-for="entry in entries" :key="entry.id" size="small" style="margin-bottom: 10px">
      <template #header>{{ dateTime(entry.createdAt) }} <NTag size="tiny" :bordered="false">rev {{ entry.revision }}</NTag></template>
      <p class="entry-body">{{ entry.body }}</p>
      <p class="provenance">{{ actorText(entry.actor) }}<template v-if="entry.sourceWorkId"> · accepted from work {{ short(entry.sourceWorkId) }}</template></p>
      <NSpace v-if="entry.files?.length" size="small" style="margin: 8px 0"><NTag v-for="f in entry.files" :key="f.rootId + ':' + f.path" size="small" class="mono">{{ f.rootId }}:{{ f.path }}</NTag></NSpace>
      <NSpace><NButton size="tiny" secondary @click="editingId = entry.id; editRevision = data.revision; editWorkspaceId = state.workspaceId; body = entry.body; filesText = (entry.files ?? []).map(f => `${f.rootId}:${f.path}`).join('\n')">Edit</NButton><NButton size="tiny" @click="showHistory(entry)">History</NButton><NButton size="tiny" type="error" secondary :disabled="busy" @click="remove(entry)">Remove</NButton></NSpace>
      <div v-if="historyId === entry.id" class="history"><strong>Entry history</strong><div v-for="version in history" :key="version.revision" class="history-row"><span>rev {{ version.revision }} · {{ dateTime(version.createdAt) }} · {{ actorText(version.actor) }}<template v-if="version.sourceWorkId"> · work {{ short(version.sourceWorkId) }}</template> · {{ version.removed ? 'removed' : 'active' }}</span><p>{{ version.body }}</p></div></div>
    </NCard>
    <h2 v-if="removedEntries.length" class="section-title">Removed references</h2>
    <NCard v-for="entry in removedEntries" :key="`removed:${entry.id}`" size="small" style="margin-bottom:10px; opacity:.8">
      <template #header>Removed · revision {{ entry.revision }}</template>
      <p class="entry-body">{{ entry.body }}</p>
      <p class="provenance">{{ actorText(entry.actor) }}<template v-if="entry.sourceWorkId"> · accepted from work {{ short(entry.sourceWorkId) }}</template></p>
      <NButton size="tiny" @click="showHistory(entry)">History</NButton>
      <div v-if="historyId === entry.id" class="history"><strong>Entry history</strong><div v-for="version in history" :key="version.revision" class="history-row"><span>rev {{ version.revision }} · {{ dateTime(version.createdAt) }} · {{ actorText(version.actor) }}<template v-if="version.sourceWorkId"> · work {{ short(version.sourceWorkId) }}</template> · {{ version.removed ? 'removed' : 'active' }}</span><p>{{ version.body }}</p></div></div>
    </NCard>
    <p class="muted" style="font-size:12px">Changes use the displayed Main revision. A stale edit must be reviewed against the latest text.</p>
  </div>
</template>

<style scoped>.entry-body { white-space: pre-wrap; line-height: 1.6; }.provenance { color:#a5adce; font-size:11px; margin:6px 0; }.history { border-top: 1px solid #414559; margin-top: 12px; padding-top: 10px; }.history-row { font-size: 12px; margin-top: 8px; color: #a5adce; }.history-row p { white-space: pre-wrap; color: #c6d0f5; }</style>
