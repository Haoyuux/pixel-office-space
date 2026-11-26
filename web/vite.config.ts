import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = 'http://127.0.0.1:5175';
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': api,
      '/assets': api,
      '/ws': { target: 'ws://127.0.0.1:5175', ws: true },
    },
  },
  test: { environment: 'node' },
});
