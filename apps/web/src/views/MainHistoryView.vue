<!-- Main history & rollback: global revisions, a Gateway-built preview of Main at any
     revision, a comparison with the current Main, and whole-snapshot or single-entry
     restore. The comparison is for review only; the Gateway performs every restore. -->
<script setup>
import { computed, h, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { NAlert, NButton, NCard, NEmpty, NGrid, NGridItem, NList, NListItem, NSpace, NSpin, NSwitch, NTag, useDialog, useMessage } from 'naive-ui';
import WordDiff from '../components/WordDiff.vue';
import { api } from '../api/index.js';
import { describe } from '../api/errors.js';
import { state } from '../state.js';
import { useData } from '../useData.js';
import { actorText, dateTime, short } from '../format.js';
import { diffSnapshots, isNoop } from '../main-diff.js';
import { fileText, useMainActions } from '../main-actions.js';

const message = useMessage();
const dialog = useDialog();
const { data, error, reload } = useData(async () => {
  const [current, revisions] = await Promise.all([api.main(state.workspaceId), api.mainRevisions(state.workspaceId)]);
  return { current, revisions };
}, () => [state.workspaceId, state.changed.context]);
const act = useMainActions({ dialog, message, reload });

const revisions = computed(() => {
  const list = [...(data.value?.revisions ?? [])].reverse();
  if (!list.some((r) => r.revision === 0)) list.push({ revision: 0, initial: true, entryIds: [] });
  return list;
});
const currentRevision = computed(() => data.value?.current.revision ?? null);

// ---- preview of the selected revision, fetched from the Gateway
const selected = ref(null);
const preview = ref(null);
const previewError = ref(null);
const loadingPreview = ref(false);
async function select(revision) {
  selected.value = revision; preview.value = null; previewError.value = null; loadingPreview.value = true;
  try {
    const result = await api.mainPreview(state.workspaceId, revision);
    if (selected.value === revision) preview.value = result;
  } catch (e) { if (selected.value === revision) previewError.value = e; }
  finally { if (selected.value === revision) loadingPreview.value = false; }
}
watch(() => state.workspaceId, () => { selected.value = null; preview.value = null; });
// Re-fetch the preview when Main moves on, so the comparison is always against the latest state.
watch(currentRevision, () => { if (selected.value !== null) select(selected.value); });

const diff = computed(() => (preview.value && data.value ? diffSnapshots(data.value.current, preview.value) : null));
const showUnchanged = ref(false);
const visibleChanges = computed(() => (diff.value?.changes ?? []).filter((c) => showUnchanged.value || c.kind !== 'unchanged'));
const KIND = {
  reverted: { label: 'will be reverted', type: 'warning' },
  readded: { label: 'will be re-added', type: 'success' },
  removed: { label: 'will be removed', type: 'error' },
  unchanged: { label: 'unchanged', type: 'default' },
};

function confirmRestoreAll() {
  const r = selected.value;
  const s = diff.value.summary;
  const lines = diff.value.changes.filter((c) => c.kind !== 'unchanged').map((c) => {
    const text = (c.kind === 'removed' ? c.current : c.target).body;
    return h('li', { style: 'margin-bottom:4px' }, [h('b', `${KIND[c.kind].label}: `), `${text.slice(0, 90)}${text.length > 90 ? '…' : ''}`]);
  });
  dialog.warning({
    title: `Restore all of Main to revision ${r}?`,
    content: () => h('div', [
      h('p', `This reverses the following changes made after revision ${r}: ${s.reverted} reverted, ${s.readded} re-added, ${s.removed} removed (${s.unchanged} unchanged).`),
      lines.length ? h('ul', { style: 'padding-left:18px; max-height:240px; overflow:auto' }, lines) : h('p', 'No entry content changes; the Gateway still records a new revision.'),
      h('p', { style: 'color:#a5adce; font-size:12px' }, `The Gateway records this as revision ${currentRevision.value + 1}. History is kept; project files, Git, branch work and agent actions are not undone.`),
    ]),
    positiveText: `Restore revision ${r}`, negativeText: 'Cancel',
    onPositiveClick: () => act(() => api.restoreMain(state.workspaceId, { revision: r, expectedRevision: currentRevision.value }), `Main restored to revision ${r}`),
  });
}

function restoreOne(change) {
  const r = selected.value;
  dialog.info({
    title: `Restore only this entry to revision ${r}?`,
    content: () => h('div', [
      change.current && !change.current.removed && change.target && !change.target.removed
        ? h(WordDiff, { before: change.current.body, after: change.target.body })
        : h('p', change.target?.removed ? 'At that revision this entry was removed, so it will be removed now.' : 'The entry comes back with its text and files from that revision.'),
      h('p', { style: 'color:#a5adce; font-size:12px' }, 'Other entries are not touched.'),
    ]),
    positiveText: 'Restore entry', negativeText: 'Cancel',
    onPositiveClick: () => act(() => api.restoreMainEntry(state.workspaceId, change.id, { revision: r, expectedRevision: currentRevision.value }), `Entry restored from revision ${r}`),
  });
}
</script>

<template>
  <div class="page">
    <div class="title-row">
      <div>
        <h1 class="page-title">Main history & rollback</h1>
        <p class="page-sub">Pick a revision to preview Main as it was, compare it with the current Main, and restore it or single entries.</p>
      </div>
      <RouterLink to="/main"><NButton size="small" secondary>Back to Main</NButton></RouterLink>
    </div>
    <NAlert v-if="error" :type="error.code === 'UNSUPPORTED' ? 'warning' : 'error'" :title="describe(error).title" style="margin-bottom: 12px">{{ describe(error).hint }}</NAlert>

    <NGrid v-if="data" cols="1 l:5" responsive="screen" :x-gap="16" :y-gap="16">
      <NGridItem span="1 l:2">
        <NCard size="small" :title="`Revisions (current: ${currentRevision})`">
          <NList hoverable clickable>
            <NListItem v-for="rev in revisions" :key="rev.revision" :class="{ active: rev.revision === selected }" @click="select(rev.revision)">
              <div class="rev">
                <NSpace size="small" align="center">
                  <NTag size="small" :type="rev.revision === currentRevision ? 'success' : 'default'" :bordered="false">rev {{ rev.revision }}</NTag>
                  <NTag v-if="rev.restoredFromRevision !== undefined" size="tiny" type="warning" :bordered="false">restore of rev {{ rev.restoredFromRevision }}</NTag>
                  <span v-if="rev.initial" class="muted small">empty initial Main</span>
                </NSpace>
                <div v-if="!rev.initial" class="muted small">{{ dateTime(rev.createdAt) }} · {{ actorText(rev.actor) }} · {{ rev.entryIds.length }} entr{{ rev.entryIds.length === 1 ? 'y' : 'ies' }}</div>
              </div>
            </NListItem>
          </NList>
        </NCard>
      </NGridItem>

      <NGridItem span="1 l:3">
        <NCard size="small" :title="selected === null ? 'Preview' : `Main at revision ${selected} compared with now`">
          <NEmpty v-if="selected === null" description="Select a revision to preview it." />
          <div v-else-if="loadingPreview" class="center"><NSpin size="small" /></div>
          <NAlert v-else-if="previewError" :type="previewError.code === 'UNSUPPORTED' ? 'warning' : 'error'" :title="describe(previewError).title">{{ describe(previewError).hint }}</NAlert>
          <template v-else-if="diff">
            <NSpace align="center" justify="space-between" style="margin-bottom: 10px">
              <NSpace size="small">
                <NTag size="small" type="warning" :bordered="false">{{ diff.summary.reverted }} reverted</NTag>
                <NTag size="small" type="success" :bordered="false">{{ diff.summary.readded }} re-added</NTag>
                <NTag size="small" type="error" :bordered="false">{{ diff.summary.removed }} removed</NTag>
                <NTag size="small" :bordered="false">{{ diff.summary.unchanged }} unchanged</NTag>
              </NSpace>
              <NButton type="warning" size="small" :disabled="selected === currentRevision" @click="confirmRestoreAll">Restore all of Main to rev {{ selected }}</NButton>
            </NSpace>
            <NAlert v-if="selected === currentRevision" type="info" :show-icon="false" style="margin-bottom: 10px">This is the current revision.</NAlert>
            <NAlert v-else-if="isNoop(diff)" type="info" :show-icon="false" style="margin-bottom: 10px">No entry would change. Restoring still records a new revision.</NAlert>
            <span class="toggle"><NSwitch v-model:value="showUnchanged" size="small" /> show unchanged entries</span>
            <div v-for="change in visibleChanges" :key="change.id" class="change">
              <NSpace align="center" justify="space-between">
                <NSpace size="small" align="center">
                  <NTag size="small" :type="KIND[change.kind].type" :bordered="false">{{ KIND[change.kind].label }}</NTag>
                  <span class="mono muted small">{{ short(change.id) }}</span>
                  <span v-if="change.createdAfterTarget" class="muted small">created after rev {{ selected }}</span>
                </NSpace>
                <NButton v-if="change.kind !== 'unchanged' && change.target" size="tiny" secondary @click="restoreOne(change)">Restore only this entry</NButton>
              </NSpace>
              <WordDiff v-if="change.kind === 'reverted'" :before="change.current.body" :after="change.target.body" />
              <p v-else class="body" :class="{ gone: change.kind === 'removed' }">{{ (change.kind === 'removed' ? change.current : change.target ?? change.current).body }}</p>
              <div v-if="change.kind === 'reverted' && JSON.stringify(change.current.files) !== JSON.stringify(change.target.files)" class="muted small">
                files: {{ (change.current.files ?? []).map(fileText).join(', ') || 'none' }} → {{ (change.target.files ?? []).map(fileText).join(', ') || 'none' }}
              </div>
            </div>
          </template>
        </NCard>
      </NGridItem>
    </NGrid>
  </div>
</template>

<style scoped>
.title-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.rev { display: flex; flex-direction: column; gap: 4px; }
.active { background: rgba(140, 170, 238, 0.12); }
.small { font-size: 12px; }
.center { display: flex; justify-content: center; padding: 30px 0; }
.toggle { display: inline-flex; gap: 6px; align-items: center; font-size: 12px; color: #a5adce; margin-bottom: 6px; }
.change { border-top: 1px solid #414559; padding: 10px 0; }
.body { white-space: pre-wrap; line-height: 1.6; margin: 6px 0 0; }
.gone { text-decoration: line-through; color: #a5adce; }
</style>
