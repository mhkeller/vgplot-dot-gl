import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    exclude: ['@duckdb/duckdb-wasm']
  },
  server: {
    fs: { allow: ['..'] }
  }
});
