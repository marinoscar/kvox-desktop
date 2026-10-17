import { defineConfig } from 'vitest/config';

// Unit tests; the Electron smoke tests are Playwright's (tests/e2e). The port
// tests open a real PGlite database (migrations included), so the timeouts are
// generous and files run one at a time.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
