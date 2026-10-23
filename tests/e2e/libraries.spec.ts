import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

import { MOCK_NOTE_TEXT, configureAiProvider } from '../support/configure-ai';
import { startOpenAiCompatibleMock, type OpenAiCompatibleMock } from '../support/openai-compatible-mock';
import { homeHeading } from '../support/rail';

// =============================================================================
// Note libraries: a folder kept in sync (marinoscar/kvox-desktop#47, epic marinoscar/kvox#708)
// =============================================================================
//
// Through the packaged app, with the Desktop file port (src/main/files/):
//
//   Notes > Libraries > Add folder   the native folder dialog (answered with a temporary folder), the
//                                    package's confirmation, then the import batch's progress page
//   a new file in the folder         the main process's watcher (2 s debounce) -> the sync controller
//                                    re-syncs on its own and says so ("Synced 1 note …")
//   a restart                        the folder and its binding come back from settings.json; the launch sync
//                                    finds nothing new
//
// No request may reach a host other than 127.0.0.1, and the window never sees the folder's absolute path.
// =============================================================================

const ROOT = resolve(__dirname, '..', '..');
const userDataDir = mkdtempSync(join(tmpdir(), 'kvox-e2e-libraries-'));
const folder = mkdtempSync(join(tmpdir(), 'kvox-e2e-library-folder-'));
const requests: string[] = [];
let app: ElectronApplication | undefined;
let provider: OpenAiCompatibleMock | undefined;


test.beforeAll(async () => {
  provider = await startOpenAiCompatibleMock(MOCK_NOTE_TEXT);
  writeFileSync(join(folder, 'standup.md'), '# Standup\n\nShipped the importer.\n');
  writeFileSync(join(folder, 'retro.txt'), 'Retro notes: keep the batch page.\n');
  writeFileSync(join(folder, 'photo.png'), 'not a note');
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await provider?.close();
  for (const dir of [userDataDir, folder]) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

async function launch(): Promise<ElectronApplication> {
  const executablePath = process.env.KVOX_E2E_EXECUTABLE;
  const launched = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: [ROOT] }),
    env: { ...process.env, KVOX_USER_DATA_DIR: userDataDir },
    timeout: 120_000,
  });
  launched.context().on('request', (request) => requests.push(request.url()));
  return launched;
}

test('a folder added as a library imports, re-syncs on a change, and is remembered across a restart', async () => {
  test.setTimeout(600_000);
  app = await launch();
  let page = await app.firstWindow();
  await expect(homeHeading(page)).toBeVisible({ timeout: 180_000 });
  await configureAiProvider(page, { baseUrl: provider!.baseUrl, apiKey: 'sk-e2e-libraries-0123456789abcdef' });

  // ---- Add folder: the folder dialog, the confirmation, the batch page ------
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
  }, folder);
  await page.getByRole('link', { name: 'Libraries' }).click();
  await page.waitForURL(/#\/notes\/libraries$/);
  await page.getByRole('button', { name: /^Add (your notes )?folder$/ }).click();
  await page.getByRole('button', { name: 'Start import' }).click();
  await page.waitForURL(/#\/notes\/import-batches\/[^/?]+$/);
  await expect(page.getByText('standup.md').first()).toBeVisible();
  await expect(page.getByText('retro.txt').first()).toBeVisible();
  await expect(page.getByText('photo.png')).toHaveCount(0);

  // ---- A new file: the watcher re-syncs without being asked ------------------
  writeFileSync(join(folder, 'planning.md'), '# Planning\n\nNext quarter.\n');
  await expect(page.getByTestId('library-sync-status')).toHaveText(/Synced 1 note/, { timeout: 60_000 });

  // ---- The window never saw the absolute path --------------------------------
  expect(await page.content()).not.toContain(folder);

  // ---- A restart: the binding is kept, the launch sync finds nothing new -----
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await expect(homeHeading(page)).toBeVisible({ timeout: 180_000 });
  await page.goto(page.url().split('#')[0] + '#/notes/libraries');
  await expect(page.getByText(/Notes|kvox-e2e-library-folder/).first()).toBeVisible();

  // ---- No egress ---------------------------------------------------------------
  const outside = requests.filter((url) => {
    const parsed = new URL(url);
    if (['kvox:', 'data:', 'blob:', 'devtools:', 'file:'].includes(parsed.protocol)) return false;
    return parsed.hostname !== '127.0.0.1';
  });
  expect(outside, 'requests to a host other than 127.0.0.1').toEqual([]);
});
