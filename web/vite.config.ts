import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** The API server port (OFFICE_PORT, default 5175), so a second dev stack can run on other ports. */
const apiPort = process.env.OFFICE_PORT ?? '5175';
const api = `http://127.0.0.1:${apiPort}`;
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': api,
      '/assets': api,
      '/ws': { target: `ws://127.0.0.1:${apiPort}`, ws: true },
    },
  },
  test: { environment: 'node' },
});
