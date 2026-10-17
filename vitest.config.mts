import { defineConfig } from 'vitest/config';

// Unit tests only; the Electron smoke test is Playwright's (tests/e2e).
export default defineConfig({
  test: { include: ['tests/unit/**/*.test.ts'], environment: 'node' },
});
