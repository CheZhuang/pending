<!-- Word-level diff of two Main bodies: removed words struck through in red, added words in green. -->
<script setup>
import { computed } from 'vue';
import { wordDiff } from '../main-diff.js';

const props = defineProps({ before: { type: String, default: '' }, after: { type: String, default: '' } });
const parts = computed(() => wordDiff(props.before, props.after));
</script>

<template>
  <p class="diff"><span v-for="(p, i) in parts" :key="i" :class="p.op">{{ p.text }}</span></p>
</template>

<style scoped>
.diff { white-space: pre-wrap; line-height: 1.6; margin: 0; }
.del { color: #e78284; text-decoration: line-through; background: #e7828418; }
.add { color: #a6d189; background: #a6d18918; }
</style>
