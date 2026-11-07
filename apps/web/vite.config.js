// Vite config for the Agentree Web Console. Keep the host on "localhost" so the
// gateway's SameSite=Strict console cookie works (gateway runs on localhost:8787).
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
