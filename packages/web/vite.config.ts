import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Subpath deployment:
//   set DOUYIN_BASE=/dy/ (with trailing slash) at build time when serving
//   under https://example.com/dy/. Defaults to '/' for local dev.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const base = env.DOUYIN_BASE || '/';
  return {
    base,
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': { target: 'http://localhost:3000', changeOrigin: true },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
    },
  };
});
