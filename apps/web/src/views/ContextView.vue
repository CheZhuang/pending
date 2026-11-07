<!-- Context: branch tree, per-branch context with authority labels, provenance, and merge history. -->
<script setup>
import { computed, h, ref, watch } from 'vue';
import {
  NAlert, NCard, NDataTable, NDescriptions, NDescriptionsItem, NDrawer, NDrawerContent, NEmpty, NRadioButton, NRadioGroup, NSpace, NSwitch, NTag,
} from 'naive-ui';
import BranchGraph from '../components/BranchGraph.vue';
import AuthorityTag from '../components/AuthorityTag.vue';
import CommitCard from '../components/CommitCard.vue';
import { describe } from '../api/errors.js';
import { clip, dateTime, scopeText, short } from '../format.js';
import { branchName, findSession, loadWorkspace, sessionLabel } from '../model.js';
import { labelSnapshot } from '../semantics.js';
import { state, workspace } from '../state.js';
import { useData } from '../useData.js';

const { data: model, error } = useData(() => loadWorkspace(workspace()), () => [state.workspaceId, state.changed.context, state.changed.reviews]);

const branchId = ref(null);
const fullHistory = ref(false);
const selectedId = ref(null);
watch(model, (m) => { if (m && !m.branches.some((b) => b.id === branchId.value)) branchId.value = m.workspace.mainBranchId; });

const branch = computed(() => model.value?.branches.find((b) => b.id === branchId.value));
const entries = computed(() => {
  const m = model.value;
  if (!m || !branchId.value) return [];
  const labelled = labelSnapshot(m.snapshots[branchId.value], m.workspace.mainBranchId);
  return fullHistory.value ? labelled : labelled.filter((e) => e.inForce || e.commit.knowledge.kind === 'finding');
});

const columns = computed(() => [
  { title: 'Status', key: 'authority', width: 190, render: (e) => h(AuthorityTag, { authority: e.authority }) },
  { title: 'Kind', key: 'kind', width: 80, render: (e) => e.commit.knowledge.kind },
  { title: 'Key', key: 'key', width: 160, render: (e) => h('span', { class: 'mono' }, e.commit.knowledge.key) },
  {
    title: 'Scope', key: 'scope', width: 230,
    render: (e) => h('span', { class: 'mono' }, scopeText(e.commit.knowledge.scope) + (e.commit.knowledge.impactScope ? ` → ${scopeText(e.commit.knowledge.impactScope)}` : '')),
  },
  { title: 'Body', key: 'body', ellipsis: { tooltip: true }, render: (e) => clip(e.commit.knowledge.body, 120) },
  { title: 'By', key: 'by', width: 140, render: (e) => sessionLabel(findSession(model.value.sessions, e.commit.provenance.sessionId)) },
  { title: 'Seen on', key: 'on', width: 110, render: (e) => (e.branchId === model.value.workspace.mainBranchId ? 'main' : 'this branch') },
]);
const rowProps = (e) => ({ style: 'cursor: pointer', onClick: () => { selectedId.value = e.commit.id; } });

// Commit drawer: provenance and every merge that carried the commit.
const selected = computed(() => {
  const m = model.value;
  if (!m || !selectedId.value) return null;
  const commit = m.commits.get(selectedId.value);
  if (!commit) return null;
  const onMain = labelSnapshot(m.snapshots[m.workspace.mainBranchId], m.workspace.mainBranchId).find((e) => e.commit.id === commit.id);
  const onAuthor = labelSnapshot(m.snapshots[commit.branchId], m.workspace.mainBranchId).find((e) => e.commit.id === commit.id && e.branchId === commit.branchId);
  const merges = m.merges.filter((x) => x.commitIds.includes(commit.id)).map((x) => ({ merge: x, review: m.reviews.find((r) => r.mergeId === x.id) }));
  return { commit, authority: onMain?.authority ?? onAuthor?.authority ?? 'finding', merges, session: findSession(m.sessions, commit.provenance.sessionId) };
});

const mergeColumns = computed(() => [
  { title: 'Merge', key: 'id', width: 100, render: (m) => h('span', { class: 'mono' }, short(m.id)) },
  { title: 'From → to', key: 'dir', render: (m) => `${branchName(model.value.branches, m.sourceBranchId)} → ${branchName(model.value.branches, m.targetBranchId)}` },
  { title: 'Commits', key: 'commits', render: (m) => m.commitIds.map((id) => model.value.commits.get(id)?.knowledge.key ?? short(id)).join(', ') },
  { title: 'State', key: 'state', width: 100, render: (m) => h(NTag, { size: 'small', bordered: false, type: m.state === 'applied' ? 'success' : m.state === 'rejected' ? 'error' : 'warning' }, () => m.state) },
  {
    title: 'Review', key: 'review', width: 220,
    render: (m) => {
      const r = model.value.reviews.find((x) => x.mergeId === m.id);
      if (!r) return 'no review needed';
      return `${r.state}${r.decidedBy ? ` by ${r.decidedBy}` : ''}${r.conflicts.length ? ` · ${r.conflicts.length} conflict(s)` : ''}`;
    },
  },
]);
</script>

<template>
  <div class="page">
    <h1 class="page-title">Context</h1>
    <p class="page-sub">Logical branches and the structured knowledge on them. Findings and proposals are unverified agent output; only main holds human-reviewed context.</p>
    <NAlert v-if="error" type="error" :title="describe(error).title" style="margin-bottom: 16px">{{ describe(error).hint }}</NAlert>

    <NCard title="Branch tree" size="small" style="margin-bottom: 16px">
      <template #header-extra>
        <NSpace :size="10" class="legend">
          <span><i class="dot" style="background: #e5c890" /> finding</span>
          <span><i class="dia" style="background: #ef9f76" /> proposed</span>
          <span><i class="dot" style="background: #81c8be" /> accepted finding</span>
          <span><i class="dia" style="background: #a6d189" /> accepted decision</span>
          <span><i class="dia" style="background: #737994" /> superseded</span>
          <span><i class="dash" /> waiting for review</span>
        </NSpace>
      </template>
      <BranchGraph v-if="model" :model="model" :selected-id="selectedId" @select="(id) => (selectedId = id)" />
      <NEmpty v-else description="Loading branches…" size="small" />
    </NCard>

    <NCard size="small" style="margin-bottom: 16px">
      <template #header>
        <NRadioGroup v-if="model" v-model:value="branchId" size="small">
          <NRadioButton v-for="b in model.branches" :key="b.id" :value="b.id">{{ b.name }}</NRadioButton>
        </NRadioGroup>
      </template>
      <template #header-extra>
        <span class="toggle"><NSwitch v-model:value="fullHistory" size="small" /> Full history (superseded &amp; shadowed)</span>
      </template>
      <p v-if="branch" class="muted" style="margin: 0 0 10px; font-size: 12.5px">
        <template v-if="branch.id === model.workspace.mainBranchId">Main: accepted context that every agent branch inherits.</template>
        <template v-else>{{ branch.name }}: its own drafts plus everything accepted on main. Revision {{ model.snapshots[branch.id]?.revision.branchRevision }} · main {{ model.snapshots[branch.id]?.revision.mainRevision }}.</template>
      </p>
      <NDataTable :columns="columns" :data="entries" :row-props="rowProps" :row-key="(e) => `${e.branchId}:${e.commit.id}`" size="small" :bordered="false" :scroll-x="1100" />
    </NCard>

    <NCard title="Merge history" size="small">
      <NDataTable v-if="model" :columns="mergeColumns" :data="[...model.merges].reverse()" size="small" :bordered="false" :scroll-x="760" />
    </NCard>

    <NDrawer :show="!!selected" :width="'min(520px, 100vw)'" @update:show="(v) => { if (!v) selectedId = null; }">
      <NDrawerContent v-if="selected" title="Commit provenance" closable>
        <CommitCard :commit="selected.commit" :authority="selected.authority" :model="model" />
        <NDescriptions :column="1" label-placement="left" size="small" bordered style="margin-top: 14px">
          <NDescriptionsItem label="Commit"><span class="mono">{{ selected.commit.id }}</span></NDescriptionsItem>
          <NDescriptionsItem label="Author session">{{ sessionLabel(selected.session) }} <span class="mono muted">{{ short(selected.commit.provenance.sessionId) }}</span></NDescriptionsItem>
          <NDescriptionsItem label="Author branch">{{ branchName(model.branches, selected.commit.branchId) }} (revision {{ selected.commit.revision }})</NDescriptionsItem>
          <NDescriptionsItem label="Created">{{ dateTime(selected.commit.createdAt) }}</NDescriptionsItem>
          <NDescriptionsItem label="Evidence events">
            <span v-if="!selected.commit.provenance.eventIds.length" class="muted">none attached</span>
            <div v-for="id in selected.commit.provenance.eventIds" :key="id" class="mono">{{ id }}</div>
          </NDescriptionsItem>
        </NDescriptions>
        <h4 style="margin: 18px 0 8px">Merges</h4>
        <NEmpty v-if="!selected.merges.length" description="Not proposed for merge yet." size="small" />
        <div v-for="{ merge, review } in selected.merges" :key="merge.id" class="merge-line">
          <NTag size="small" :bordered="false" :type="merge.state === 'applied' ? 'success' : merge.state === 'rejected' ? 'error' : 'warning'">{{ merge.state }}</NTag>
          {{ branchName(model.branches, merge.sourceBranchId) }} → {{ branchName(model.branches, merge.targetBranchId) }}
          <span v-if="review" class="muted">· review {{ review.state }}{{ review.decidedBy ? ` by ${review.decidedBy}` : '' }}</span>
        </div>
      </NDrawerContent>
    </NDrawer>
  </div>
</template>

<style scoped>
.toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; }
.legend { font-size: 12px; color: #a5adce; }
.legend span { display: inline-flex; align-items: center; gap: 5px; }
.dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }
.dia { display: inline-block; width: 9px; height: 9px; transform: rotate(45deg); }
.dash { display: inline-block; width: 18px; border-top: 2px dashed #e5c890; }
.merge-line { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; font-size: 13px; }
</style>
