import { defineConfig } from 'vitest/config';

// The child of tests/unit/jobs-crash-recovery.test.ts: one test file that starts a
// job and hangs until it is killed. Threads, so the test runs inside the very
// process the parent kills.
export default defineConfig({
  test: {
    include: ['tests/crash/**/*.child.ts'],
    environment: 'node',
    pool: 'threads',
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
