import { defineConfig } from '@playwright/test';

// Playwright for Electron: one smoke spec, serial, generous timeouts (the first
// launch creates the database and applies every migration).
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 240_000,
  expect: { timeout: 60_000 },
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { trace: 'retain-on-failure' },
});
