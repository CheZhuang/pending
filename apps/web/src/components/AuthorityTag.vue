<!-- Colored tag for a sync authority label (finding, proposed, accepted, superseded). -->
<script setup>
import { computed } from 'vue';
import { NTag } from 'naive-ui';
import { authorityColor } from '../theme.js';
import { AUTHORITY_TEXT } from '../semantics.js';

const props = defineProps({ authority: { type: String, required: true }, size: { type: String, default: 'small' } });
const color = computed(() => {
  const c = authorityColor[props.authority] ?? '#838ba7';
  return { color: `${c}22`, textColor: c, borderColor: `${c}66` };
});
</script>

<template>
  <NTag :size="size" :color="color" :bordered="true" class="authority" :class="{ strike: authority === 'superseded-decision' }">
    {{ AUTHORITY_TEXT[authority] ?? authority }}
  </NTag>
</template>

<style scoped>
.authority { font-weight: 500; }
.strike :deep(.n-tag__content) { text-decoration: line-through; }
</style>
