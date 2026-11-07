<!-- One context commit: authority, key, scopes, body and provenance. -->
<script setup>
import { NTag } from 'naive-ui';
import AuthorityTag from './AuthorityTag.vue';
import { dateTime, scopeText, short } from '../format.js';
import { branchName, findSession, sessionLabel } from '../model.js';

defineProps({
  commit: { type: Object, default: null },
  authority: { type: String, default: '' },
  model: { type: Object, required: true },
  selected: { type: Boolean, default: false },
  label: { type: String, default: '' },
});
</script>

<template>
  <div v-if="commit" class="commit" :class="{ selected }">
    <div class="head">
      <span v-if="label" class="label">{{ label }}</span>
      <AuthorityTag v-if="authority" :authority="authority" />
      <NTag size="tiny" :bordered="false">{{ commit.knowledge.kind }}</NTag>
      <span class="key mono">{{ commit.knowledge.key }}</span>
    </div>
    <div class="body">{{ commit.knowledge.body }}</div>
    <div class="meta muted">
      <span class="mono">@ {{ scopeText(commit.knowledge.scope) }}</span>
      <span v-if="commit.knowledge.impactScope" class="mono"> → impacts {{ scopeText(commit.knowledge.impactScope) }}</span>
    </div>
    <div class="meta muted">
      by {{ sessionLabel(findSession(model.sessions, commit.provenance.sessionId)) }}
      on {{ branchName(model.branches, commit.branchId) }} · {{ dateTime(commit.createdAt) }} · <span class="mono">{{ short(commit.id) }}</span>
    </div>
  </div>
  <div v-else class="commit muted">Commit not visible to this console.</div>
</template>

<style scoped>
.commit { border: 1px solid #414559; border-radius: 6px; padding: 10px 12px; background: #292c3c; transition: border-color .15s; }
.commit.selected { border-color: #a6d189; box-shadow: 0 0 0 1px #a6d18966; }
.head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
.label { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #a5adce; }
.key { color: #babbf1; }
.body { color: #c6d0f5; line-height: 1.45; margin-bottom: 6px; }
.meta { font-size: 12px; line-height: 1.6; }
</style>
