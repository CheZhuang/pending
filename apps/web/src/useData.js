// Load data for a view and reload it when its dependencies change (workspace
// switch, or a matching live event). Bursts of events collapse into one reload.
import { onBeforeUnmount, ref, watch } from 'vue';
import { guard } from './state.js';

export function useData(load, deps, { delay = 150 } = {}) {
  const data = ref(null);
  const error = ref(null);
  const loading = ref(false);
  let timer = null;
  let run = 0;

  async function reload() {
    const mine = ++run;
    loading.value = true;
    try {
      const result = await guard(load);
      if (mine === run) { data.value = result; error.value = null; }
    } catch (e) {
      if (mine === run) error.value = e;
    } finally {
      if (mine === run) loading.value = false;
    }
  }

  watch(deps, () => { clearTimeout(timer); timer = setTimeout(reload, data.value ? delay : 0); }, { immediate: true });
  onBeforeUnmount(() => clearTimeout(timer));
  return { data, error, loading, reload };
}

/** A ref holding Date.now(), updated every second (for countdowns). */
export function useNow() {
  const now = ref(Date.now());
  const timer = setInterval(() => { now.value = Date.now(); }, 1000);
  onBeforeUnmount(() => clearInterval(timer));
  return now;
}
