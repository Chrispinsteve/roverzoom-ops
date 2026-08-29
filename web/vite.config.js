import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5300, // deliberately not 5200 — the rider/driver app owns that
    proxy: {
      // In development the console and the ops API are same-origin through
      // this proxy, so CORS never enters the picture locally.
      '/api': 'http://localhost:4100',
    },
  },
  preview: { port: 5300, proxy: { '/api': 'http://localhost:4100' } },
  build: { outDir: 'dist', sourcemap: false },
});
