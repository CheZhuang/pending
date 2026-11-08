// Vite config for the PendingTree Web Console. The live dev mode talks to the
// Gateway on localhost:8787; built assets use the Gateway's same origin.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  plugins: [vue()],
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
    // Allow importing shared sync semantics (authority labels) from packages/.
    fs: { allow: [repoRoot] },
  },
  preview: { host: 'localhost', port: 5173, strictPort: true },
  // Naive UI is one ~600 kB chunk; that is expected for a local console.
  build: { chunkSizeWarningLimit: 900 },
});
