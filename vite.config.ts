import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const BACKEND = 'http://127.0.0.1:4401';

export default defineConfig({
  root: fileURLToPath(new URL('./src/ui', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('./dist/ui', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 800,
  },
  server: {
    port: 4409,
    strictPort: true,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: false },
      '/hilfe': { target: BACKEND, changeOrigin: false },
    },
  },
  preview: { port: 4409, strictPort: true },
});
