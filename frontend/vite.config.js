import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, forward /api to the local backend so cookies stay same-origin (same as Netlify's proxy in production).
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:10000' } },
});
