import { defineConfig } from 'vitest/config';

// Unit tests only. The browser suite in tests/e2e has its own runner.
export default defineConfig({
  test: { include: ['tests/unit/**/*.test.js'] }
});
