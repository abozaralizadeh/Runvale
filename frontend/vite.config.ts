import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative URLs, so the same build works at / and under a path like /runvale/.
  base: './',
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:8790' } },
  build: { outDir: 'dist', sourcemap: false },
});
