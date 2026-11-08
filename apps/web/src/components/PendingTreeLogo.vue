<script setup>
import { computed } from 'vue';

const props = defineProps({
  size: { type: Number, default: 32 },
  showText: { type: Boolean, default: true },
  theme: { type: String, default: 'dark' },
});

const iconSize = computed(() => `${props.size}px`);
const wordmarkWidth = computed(() => `${props.size * 260 / 64}px`);
</script>

<template>
  <img
    v-if="showText && theme === 'dark'"
    src="/logo.svg"
    alt="PendingTree"
    :width="size * 260 / 64"
    :height="size"
    :style="{ width: wordmarkWidth, height: iconSize }"
  />
  <span v-else class="pending-tree-logo" :class="theme" :style="{ fontSize: `${size * 0.48}px` }">
    <img src="/favicon.svg" :alt="showText ? '' : 'PendingTree'" :width="size" :height="size" />
    <span v-if="showText">PendingTree</span>
  </span>
</template>

<style scoped>
.pending-tree-logo { display: inline-flex; align-items: center; gap: 0.35em; font-weight: 600; line-height: 1; white-space: nowrap; }
.pending-tree-logo.dark { color: #c9cff7; }
.pending-tree-logo.light { color: #293047; }
</style>
