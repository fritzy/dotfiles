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
      '/fw': {
        target: 'http://127.0.0.1:7337',
        ws: true,
      },
      '/notes': 'http://127.0.0.1:7337',
      '/markdown': 'http://127.0.0.1:7337',
      '/daemons': 'http://127.0.0.1:7337',
      '/panel-layout': 'http://127.0.0.1:7337',
      '/browser': 'http://127.0.0.1:7337',
      '/resource-files': 'http://127.0.0.1:7337',
      '/health': 'http://127.0.0.1:7337',
      '/icons': 'http://127.0.0.1:7337',
    },
  },
});
