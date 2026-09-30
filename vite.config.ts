import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * `base: './'` produces relative asset URLs, so the same build works at
 * https://<user>.github.io/<repo>/, at a custom domain root, or from any
 * sub-folder — no rebuild needed. Override with BASE_PATH if you prefer.
 */
export default defineConfig({
  base: process.env.BASE_PATH ?? './',
  plugins: [react(), tailwindcss()],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 6000,
    sourcemap: false,
  },
  server: { port: 5173, strictPort: false },
  preview: { port: 4173 },
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.ts'],
    setupFiles: ['tests/unit/setup.ts'],
  },
} as import('vite').UserConfig);
