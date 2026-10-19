import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { openSettingsCard } from '../support/configure-ai';

// =============================================================================
// Updates are opt-in (marinoscar/kvox#587, ADR-0004)
// =============================================================================
//
// A loopback update feed (`KVOX_UPDATE_FEED_URL`, honoured only for loopback)
// stands in for GitHub Releases and records every request. With "Check for
// updates" off, the default, the app makes NO request to it, across a whole
// launch. Turned on in Settings, the app asks it for `latest*.yml` at once,
// reports "latest version" (the feed offers 0.0.0) and keeps the choice
// across a restart. Turned off again, the next launch makes no request.
// =============================================================================

const ROOT = resolve(__dirname, '..', '..');
const userDataDir = mkdtempSync(join(tmpdir(), 'kvox-e2e-updates-'));
const feedRequests: string[] = [];
const mainLog: string[] = [];
const fullLog: string[] = [];
let feed: Server | undefined;
let feedUrl = '';
let app: ElectronApplication | undefined;

test.beforeAll(async () => {
  feed = createServer((request, response) => {
    // electron-updater adds a cache-busting query: record the path.
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    feedRequests.push(path);
    if (/latest.*\.yml$/.test(path)) {
      response.writeHead(200, { 'content-type': 'text/yaml' });
      response.end('version: 0.0.0\nfiles:\n  - url: KVox-0.0.0.bin\n    sha512: none\n    size: 1\npath: KVox-0.0.0.bin\nsha512: none\nreleaseDate: 2026-01-01T00:00:00.000Z\n');
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((done) => feed!.listen(0, '127.0.0.1', () => done()));
  const address = feed.address();
  feedUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`;
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  // Everything the app printed across the launches, for a failed run's artifact.
  mkdirSync(join(ROOT, 'test-results'), { recursive: true });
  writeFileSync(join(ROOT, 'test-results', 'updates-app.log'), `${fullLog.join('\n')}\n`);
  await new Promise<void>((done) => (feed ? feed.close(() => done()) : done()));
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

async function launch(): Promise<Page> {
  const executablePath = process.env.KVOX_E2E_EXECUTABLE;
  mainLog.length = 0;
  app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: [ROOT] }),
    env: {
      ...process.env,
      KVOX_USER_DATA_DIR: userDataDir,
      KVOX_UPDATE_FEED_URL: feedUrl,
      // electron-updater updates an AppImage only when it runs as one; the unpacked Linux app stands in for it.
      ...(process.platform === 'linux' ? { APPIMAGE: join(userDataDir, 'KVox.AppImage') } : {}),
    },
    timeout: 120_000,
  });
  const collect = (chunk: Buffer) => {
    const lines = chunk.toString().split('\n').filter(Boolean);
    mainLog.push(...lines);
    fullLog.push(...lines);
  };
  app.process().stdout?.on('data', collect);
  app.process().stderr?.on('data', collect);
  const page = await app.firstWindow();
  await expect(page.getByRole('heading', { name: 'Notes', level: 1 })).toBeVisible({ timeout: 180_000 });
  return page;
}

async function quiet(ms: number): Promise<void> {
  await new Promise((done) => setTimeout(done, ms));
}

test('no update request is made unless the user turns on "Check for updates"', async () => {
  // ---- Off (the default): a whole launch, the settings page included, and no request ----
  let page = await launch();
  await openSettingsCard(page, 'Updates');
  const toggle = page.getByLabel('Check for updates');
  await expect(toggle).not.toBeChecked();
  await expect(page.getByRole('status').filter({ hasText: 'does not contact any update server' })).toBeVisible();
  await quiet(5_000);
  expect(feedRequests, 'update requests while updates are off').toEqual([]);

  // ---- On: the feed is asked at once ----------------------------------------------
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect.poll(() => feedRequests.filter((url) => /latest.*\.yml$/.test(url)).length, { timeout: 60_000 }).toBeGreaterThan(0);
  await expect(page.getByRole('status').filter({ hasText: 'is the latest version' })).toBeVisible({ timeout: 60_000 });
  expect(mainLog.some((line) => line.includes('updates: on, allowing github.com'))).toBe(true);
  await app!.close();

  // ---- The choice survives a restart: the new launch checks without being asked ----
  feedRequests.length = 0;
  page = await launch();
  await expect.poll(() => feedRequests.length, { timeout: 60_000 }).toBeGreaterThan(0);

  // ---- Off again: the next launch makes no request ---------------------------------
  await openSettingsCard(page, 'Updates');
  await expect(page.getByLabel('Check for updates')).toBeChecked();
  await expect(page.getByRole('status').filter({ hasText: 'is the latest version' })).toBeVisible({ timeout: 60_000 });
  await page.getByLabel('Check for updates').click();
  await expect(page.getByLabel('Check for updates')).not.toBeChecked();
  await expect(page.getByRole('status').filter({ hasText: 'does not contact any update server' })).toBeVisible();
  await app!.close();
  feedRequests.length = 0;
  await launch();
  await quiet(5_000);
  expect(feedRequests, 'update requests after updates were turned off').toEqual([]);
  expect(mainLog.filter((line) => line.includes('egress blocked')), 'requests a guard cancelled').toEqual([]);
});
