<!-- Root: Naive UI theme + message/dialog/notification providers around the shell. -->
<script setup>
import { NConfigProvider, NDialogProvider, NGlobalStyle, NMessageProvider, NNotificationProvider } from 'naive-ui';
import AppShell from './components/AppShell.vue';
import { theme, themeOverrides } from './theme.js';
</script>

<template>
  <NConfigProvider :theme="theme" :theme-overrides="themeOverrides">
    <NGlobalStyle />
    <NNotificationProvider placement="bottom-right" :max="4">
      <NMessageProvider>
        <NDialogProvider>
          <AppShell />
        </NDialogProvider>
      </NMessageProvider>
    </NNotificationProvider>
  </NConfigProvider>
</template>

<style>
body { font-feature-settings: 'tnum'; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
.muted { color: #a5adce; }
.page { padding: 20px 24px 40px; max-width: 1400px; margin: 0 auto; box-sizing: border-box; }
.page-title { font-size: 20px; font-weight: 600; margin: 0 0 4px; color: #c6d0f5; }
.page-sub { margin: 0 0 18px; color: #a5adce; font-size: 13px; }
/* Card headers wrap instead of squeezing the title when there is extra content. */
.n-card-header { flex-wrap: wrap; row-gap: 6px; }
.n-card-header__main { min-width: max-content; }
pre.json { margin: 0; padding: 12px; background: #232634; border-radius: 6px; overflow: auto; max-height: 420px; font-size: 12px; line-height: 1.5; }
@media (max-width: 640px) { .page { padding: 14px 16px 32px; } }
</style>
