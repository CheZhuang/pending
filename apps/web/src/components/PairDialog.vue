<!-- Pairs this browser with the gateway: the admin token is sent once to
     /v1/console/login, which sets an HttpOnly cookie. The token is never stored. -->
<script setup>
import { ref } from 'vue';
import { NAlert, NButton, NInput, NModal, NSpace } from 'naive-ui';
import { describe } from '../api/errors.js';
import { pair, state } from '../state.js';

const token = ref('');
const busy = ref(false);
const error = ref(null);

async function submit() {
  if (!token.value.trim()) return;
  busy.value = true;
  error.value = null;
  try {
    await pair(token.value.trim());
    token.value = '';
  } catch (e) {
    error.value = describe(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <NModal :show="state.needsLogin" :mask-closable="false" preset="card" title="Pair with the local gateway" style="width: min(520px, calc(100vw - 32px))">
    <p class="muted" style="margin-top: 0">
      The gateway at <span class="mono">{{ state.baseUrl }}</span> needs the local admin token once.
      It exchanges it for an 8-hour browser cookie; the token itself is not kept by this page.
    </p>
    <p class="mono muted">cat ~/.local/share/agentree/admin-token</p>
    <NInput v-model:value="token" type="password" show-password-on="click" placeholder="Admin token" :input-props="{ autocomplete: 'off' }" @keydown.enter="submit" />
    <NAlert v-if="error" type="error" :title="error.title" style="margin-top: 12px">{{ error.hint }}</NAlert>
    <template #footer>
      <NSpace justify="end">
        <NButton type="primary" :loading="busy" :disabled="!token.trim()" @click="submit">Pair browser</NButton>
      </NSpace>
    </template>
  </NModal>
</template>
