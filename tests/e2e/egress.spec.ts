import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

import type { KvoxDesktopBridge } from '../../src/shared/protocol';

// =============================================================================
// The window cannot reach the internet; the server's guard is on (marinoscar/kvox#583)
// =============================================================================
//
// Two layers guard the window: the page's CSP (`connect-src` is loopback only)
// refuses a fetch to example.com outright, and the session's `onBeforeRequest`
// cancels anything non-local that gets past a page (here: a hidden window on
// the same session, loading example.com with no CSP at all), logged at error
// level with the host only. The server process's guard is
// exercised against real requests in tests/unit/egress-guard.test.ts; here the
// packaged server reports it installed it. The "Data and privacy" card renders
// with the user data folder, and, on a Linux session with no keyring, the
// warning that keys would be stored without encryption.
// =============================================================================

const ROOT = resolve(__dirname, '..', '..');
const userDataDir = mkdtempSync(join(tmpdir(), 'kvox-e2e-egress-'));
const mainLog: string[] = [];
let app: ElectronApplication | undefined;

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

test('a request to a non-allowlisted host is blocked in the window and logged with the host only', async () => {
  const executablePath = process.env.KVOX_E2E_EXECUTABLE;
  app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: [ROOT] }),
    env: { ...process.env, KVOX_USER_DATA_DIR: userDataDir },
    timeout: 120_000,
  });
  app.process().stdout?.on('data', (chunk: Buffer) => mainLog.push(...chunk.toString().split('\n').filter(Boolean)));
  app.process().stderr?.on('data', (chunk: Buffer) => mainLog.push(...chunk.toString().split('\n').filter(Boolean)));
  const page = await app.firstWindow();
  await expect(page.getByRole('heading', { name: 'Notes', level: 1 })).toBeVisible({ timeout: 180_000 });

  const outcome = await page.evaluate(() =>
    fetch('https://example.com/private/path?token=secret').then(
      () => 'reached',
      () => 'blocked',
    ),
  );
  expect(outcome).toBe('blocked');
  const loaded = await app.evaluate(async ({ BrowserWindow }) => {
    const probe = new BrowserWindow({ show: false });
    try {
      await probe.loadURL('https://example.com/private/path?token=secret');
      return 'reached';
    } catch (error) {
      return String(error);
    } finally {
      probe.destroy();
    }
  });
  expect(loaded).toContain('ERR_BLOCKED_BY_CLIENT');
  await expect.poll(() => mainLog.filter((line) => line.includes('window: egress blocked: example.com')).length).toBeGreaterThan(0);
  const blocked = mainLog.filter((line) => line.includes('egress blocked'));
  expect(blocked.every((line) => line.includes('ERROR'))).toBe(true);
  expect(blocked.join('\n')).not.toMatch(/private|token|secret/);
  expect(mainLog.some((line) => line.includes('server: egress guard on, allowing loopback and api.openai.com'))).toBe(true);

  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Data and privacy' })).toBeVisible();
  await expect(page.getByText(userDataDir, { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export data…' })).toBeEnabled();

  // Linux with no keyring (a CI session under xvfb): the card warns before any key is saved.
  const storage = await page.evaluate(() => (window as unknown as { kvoxDesktop: KvoxDesktopBridge }).kvoxDesktop.secretStorage());
  test.info().annotations.push({ type: 'safeStorage backend', description: String(storage.backend) });
  if (storage.backend === 'basic_text') {
    await expect(page.getByRole('alert').filter({ hasText: 'No system keyring is available' })).toBeVisible();
    await expect(page.getByLabel('Store keys without system encryption on this device')).not.toBeChecked();
  } else {
    await expect(page.getByRole('alert').filter({ hasText: 'No system keyring' })).toHaveCount(0);
  }
});
