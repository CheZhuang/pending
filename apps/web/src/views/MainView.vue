<!-- Main: the human-governed shared reference. Create, edit, remove and restore
     entries; inspect each entry's versions. Every write goes to the Gateway with the
     displayed global revision; the Gateway owns history. -->
<script setup>
import { computed, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { NAlert, NButton, NCard, NDrawer, NDrawerContent, NEmpty, NInput, NSpace, NTag, NTimeline, NTimelineItem, useDialog, useMessage } from 'naive-ui';
import WordDiff from '../components/WordDiff.vue';
import { api } from '../api/index.js';
import { describe, errorText } from '../api/errors.js';
import { state, workspace } from '../state.js';
import { useData } from '../useData.js';
import { actorText, dateTime, short } from '../format.js';
import { lastActiveRevision } from '../main-diff.js';
import { fileText, parseFiles, useMainActions } from '../main-actions.js';
import { mainWriteTarget } from './main-write.js';

const message = useMessage();
const dialog = useDialog();
const { data, error, reload } = useData(() => api.main(state.workspaceId), () => [state.workspaceId, state.changed.context]);
const act = useMainActions({ dialog, message, reload });

const roots = computed(() => workspace()?.roots ?? []);
const entries = computed(() => data.value?.entries ?? []);
const removedEntries = computed(() => data.value?.removedEntries ?? []);

// ---- editor: create or edit; an edit keeps the entry id and the revision it started from
const body = ref('');
const filesText = ref('');
const editing = ref(null); // { id, revision, workspaceId, original }
const busy = ref(false);
const resetEditor = () => { body.value = ''; filesText.value = ''; editing.value = null; };
watch(() => state.workspaceId, resetEditor);

function startEdit(entry) {
  editing.value = { id: entry.id, revision: data.value.revision, workspaceId: state.workspaceId, original: entry.body };
  body.value = entry.body;
  filesText.value = (entry.files ?? []).map(fileText).join('\n');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function save() {
  if (!body.value.trim()) return;
  let files;
  try { files = parseFiles(filesText.value, roots.value); } catch (e) { message.error(e.message); return; }
  let target;
  try {
    target = mainWriteTarget({ editingId: editing.value?.id, editRevision: editing.value?.revision, editWorkspaceId: editing.value?.workspaceId, workspaceId: state.workspaceId, currentRevision: data.value.revision });
  } catch (e) { message.error(e.message); return; }
  busy.value = true;
  const payload = { body: body.value, files, expectedRevision: target.expectedRevision };
  const done = await act(() => (target.entryId ? api.updateMainEntry(state.workspaceId, target.entryId, payload) : api.updateMain(state.workspaceId, payload)),
    target.entryId ? 'Main entry updated' : 'Added to Main');
  if (done) resetEditor();
  busy.value = false;
}

function remove(entry) {
  dialog.warning({
    title: 'Remove this entry from Main?',
    content: `“${entry.body.slice(0, 140)}${entry.body.length > 140 ? '…' : ''}” stays in history and can be restored. Agents stop receiving it on their next sync.`,
    positiveText: 'Remove', negativeText: 'Cancel',
    onPositiveClick: () => act(() => api.removeMainEntry(state.workspaceId, entry.id, { expectedRevision: data.value.revision }), 'Entry removed (restorable)'),
  });
}

async function restoreRemoved(entry) {
  busy.value = true;
  try {
    const history = await api.mainHistory(state.workspaceId, entry.id);
    const revision = lastActiveRevision(history);
    if (revision === null) { message.error('This entry has no active version to restore.'); return; }
    await act(() => api.restoreMainEntry(state.workspaceId, entry.id, { revision, expectedRevision: data.value.revision }), `Entry restored from revision ${revision}`);
  } catch (e) { message.error(errorText(e), { duration: 7000 }); } finally { busy.value = false; }
}

// ---- per-entry history drawer
const historyEntry = ref(null);
const history = ref([]);
const historyError = ref(null);
async function openHistory(entry) {
  historyEntry.value = entry; history.value = []; historyError.value = null;
  try {
    const result = await api.mainHistory(state.workspaceId, entry.id);
    if (historyEntry.value?.id === entry.id) history.value = [...result].reverse();
  } catch (e) { historyError.value = e; }
}
const currentOf = (id) => [...entries.value, ...removedEntries.value].find((e) => e.id === id);
function restoreVersion(version) {
  const current = currentOf(version.id);
  dialog.info({
    title: `Restore this entry to revision ${version.revision}?`,
    content: version.removed ? 'At that revision the entry was removed, so restoring removes it now.' : 'The entry text and files become this version. Other entries are not touched. History keeps every version.',
    positiveText: 'Restore entry', negativeText: 'Cancel',
    onPositiveClick: async () => {
      const done = await act(() => api.restoreMainEntry(state.workspaceId, version.id, { revision: version.revision, expectedRevision: data.value.revision }), `Entry restored from revision ${version.revision}`);
      if (done && current) openHistory(current);
    },
  });
}
const provenance = (entry) => [
  actorText(entry.actor),
  entry.sourceWorkId ? `accepted from work ${short(entry.sourceWorkId)}` : '',
  entry.restoredFrom ? `restored from rev ${entry.restoredFrom.revision}` : '',
].filter(Boolean).join(' · ');
</script>

<template>
  <div class="page">
    <div class="title-row">
      <div>
        <h1 class="page-title">Main</h1>
        <p class="page-sub">The shared, human-maintained reference agents receive. It is not a Git branch and never edits project files.</p>
      </div>
      <NSpace align="center">
        <NTag v-if="data" round :bordered="false" type="info">Revision {{ data.revision }}</NTag>
        <RouterLink to="/main/history"><NButton size="small" secondary>History & rollback</NButton></RouterLink>
      </NSpace>
    </div>
    <NAlert v-if="error" type="error" :title="describe(error).title" style="margin-bottom: 12px">{{ describe(error).hint }}</NAlert>

    <NCard :title="editing ? `Edit entry ${short(editing.id)}` : 'Add to Main'" size="small" style="margin-bottom: 16px">
      <template v-if="editing" #header-extra><span class="muted small">editing from revision {{ editing.revision }}</span></template>
      <NInput v-model:value="body" type="textarea" :autosize="{ minRows: 3, maxRows: 10 }" placeholder="A project expectation, context, or accepted outcome agents should follow…" />
      <NInput v-model:value="filesText" type="textarea" :autosize="{ minRows: 1, maxRows: 4 }" :placeholder="`Related files, one per line (${roots.map(r => r.id).join(', ') || 'root'}:path)`" style="margin-top: 8px" />
      <div v-if="editing && body !== editing.original" class="preview">
        <div class="muted small">Change preview</div>
        <WordDiff :before="editing.original" :after="body" />
      </div>
      <NSpace justify="end" style="margin-top: 8px">
        <NButton v-if="editing" size="small" @click="resetEditor">Cancel edit</NButton>
        <NButton type="primary" size="small" :disabled="!data || !body.trim()" :loading="busy" @click="save">{{ editing ? 'Save changes' : 'Add reference' }}</NButton>
      </NSpace>
    </NCard>

    <NEmpty v-if="data && !entries.length" description="Main has no active entries." style="margin: 24px 0" />
    <NCard v-for="entry in entries" :key="entry.id" size="small" class="entry" :class="{ editing: editing?.id === entry.id }">
      <p class="entry-body">{{ entry.body }}</p>
      <NSpace v-if="entry.files?.length" size="small" style="margin: 6px 0"><NTag v-for="f in entry.files" :key="fileText(f)" size="small" class="mono">{{ fileText(f) }}</NTag></NSpace>
      <div class="meta">
        <span class="muted small">rev {{ entry.revision }} · {{ dateTime(entry.createdAt) }} · {{ provenance(entry) }}</span>
        <NSpace size="small">
          <NButton size="tiny" secondary @click="startEdit(entry)">Edit</NButton>
          <NButton size="tiny" @click="openHistory(entry)">History</NButton>
          <NButton size="tiny" type="error" secondary :disabled="busy" @click="remove(entry)">Remove</NButton>
        </NSpace>
      </div>
    </NCard>

    <template v-if="removedEntries.length">
      <h2 class="section-title">Removed entries</h2>
      <NCard v-for="entry in removedEntries" :key="`removed:${entry.id}`" size="small" class="entry removed">
        <p class="entry-body">{{ entry.body }}</p>
        <div class="meta">
          <span class="muted small">removed at rev {{ entry.revision }} · {{ provenance(entry) }}</span>
          <NSpace size="small">
            <NButton size="tiny" @click="openHistory(entry)">History</NButton>
            <NButton size="tiny" type="primary" secondary :disabled="busy" @click="restoreRemoved(entry)">Restore</NButton>
          </NSpace>
        </div>
      </NCard>
    </template>

    <NDrawer :show="!!historyEntry" :width="'min(620px, 100vw)'" @update:show="(v) => { if (!v) historyEntry = null; }">
      <NDrawerContent v-if="historyEntry" :title="`Entry ${short(historyEntry.id)} · versions`" closable>
        <NAlert v-if="historyError" type="error" :title="describe(historyError).title">{{ describe(historyError).hint }}</NAlert>
        <p class="muted small" style="margin-top: 0">Newest first. Differences are shown against the current version. Restoring creates a new revision; history is never rewritten.</p>
        <NTimeline>
          <NTimelineItem v-for="(version, i) in history" :key="version.revision" :type="i === 0 ? 'success' : version.removed ? 'error' : 'default'"
            :title="`Revision ${version.revision}${i === 0 ? ' · current' : ''}${version.removed ? ' · removed' : ''}${version.restoredFrom ? ` · restored from rev ${version.restoredFrom.revision}` : ''}`"
            :time="`${dateTime(version.createdAt)} · ${actorText(version.actor)}`">
            <WordDiff v-if="i > 0" :before="history[0].body" :after="version.body" />
            <p v-else class="entry-body">{{ version.body }}</p>
            <NSpace v-if="version.files?.length" size="small" style="margin: 6px 0"><NTag v-for="f in version.files" :key="fileText(f)" size="tiny" class="mono">{{ fileText(f) }}</NTag></NSpace>
            <NButton v-if="i > 0" size="tiny" secondary style="margin-top: 6px" @click="restoreVersion(version)">Restore this version</NButton>
          </NTimelineItem>
        </NTimeline>
      </NDrawerContent>
    </NDrawer>
  </div>
</template>

<style scoped>
.title-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.entry { margin-bottom: 10px; }
.entry.editing { border-color: #8caaee; }
.entry.removed { opacity: 0.75; }
.entry-body { white-space: pre-wrap; line-height: 1.6; margin: 0; }
.meta { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
.small { font-size: 12px; }
.preview { margin-top: 10px; padding: 10px; background: #232634; border-radius: 6px; }
.section-title { font-size: 15px; margin: 22px 0 10px; color: #c6d0f5; }
</style>
