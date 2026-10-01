import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development, point VITE_DAEMON at a running daemon (e.g. http://127.0.0.1:47257)
// and open http://localhost:5173/?t=<token>.
const daemon = process.env['VITE_DAEMON'];

export default defineConfig({
  plugins: [react()],
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 2_000 },
  server: daemon
    ? { proxy: { '/ws': { target: daemon.replace(/^http/u, 'ws'), ws: true }, '/api': daemon } }
    : {},
});
