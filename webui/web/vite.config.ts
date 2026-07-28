import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev-only proxy so the Vite dev server and the Fastify API can share
// cookies under one origin (SameSite=Lax needs same-site, not necessarily
// same-port, but this avoids CORS entirely and matches how it's served in
// production — the backend serves the built frontend directly, no proxy).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_PROXY_TARGET ?? 'http://localhost:8080',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
