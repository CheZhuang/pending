// Web Console entry: Vue app + router. Naive UI components are imported where used.
import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router.js';

createApp(App).use(router).mount('#app');
