import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: 'web-v2',
  base: '/v2/',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../web/v2',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    proxy: {
      '/ws': {
        target: 'http://127.0.0.1:7337',
        ws: true,
      },
      '/icons': 'http://127.0.0.1:7337',
    },
  },
});
