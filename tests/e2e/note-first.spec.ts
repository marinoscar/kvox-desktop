import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';

import { MOCK_NOTE_TEXT, configureAiProvider } from '../support/configure-ai';
import { startOpenAiCompatibleMock, type OpenAiCompatibleMock } from '../support/openai-compatible-mock';
import { homeHeading } from '../support/rail';

// =============================================================================
// Note-first Desktop (marinoscar/kvox-desktop#49, epic marinoscar/kvox#728)
// =============================================================================
//
// Desktop never records or transcribes (ADR-0006), so the host sets features().transcription to false:
//
//   Home                       the note-first journey, and no word about recording, audio or a microphone
//   New note > A document      a Word file kept as a note ("Keep it as my note"), opened once imported,
//                              and the note names the file it was imported from
// =============================================================================

const ROOT = resolve(__dirname, '..', '..');
const userDataDir = mkdtempSync(join(tmpdir(), 'kvox-e2e-note-first-'));
let app: ElectronApplication | undefined;
let provider: OpenAiCompatibleMock | undefined;

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const DOCX = zipSync({
  '[Content_Types].xml': strToU8('<Types/>'),
  'word/document.xml': strToU8(
    `<w:document ${W}><w:body>` +
      '<w:p><w:r><w:t>Quarterly planning</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t xml:space="preserve">We agreed to ship the importer before the review.</w:t></w:r></w:p>' +
      '</w:body></w:document>',
  ),
});

test.beforeAll(async () => {
  provider = await startOpenAiCompatibleMock(MOCK_NOTE_TEXT);
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await provider?.close();
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

test('Home is note-first with no recording wording, and a Word document is kept as a note', async () => {
  test.setTimeout(600_000);
  const executablePath = process.env.KVOX_E2E_EXECUTABLE;
  app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: [ROOT] }),
    env: { ...process.env, KVOX_USER_DATA_DIR: userDataDir },
    timeout: 120_000,
  });
  const page = await app.firstWindow();
  await expect(homeHeading(page)).toBeVisible({ timeout: 180_000 });

  // ---- Home: the note-first journey, nothing about audio ---------------------
  await expect(page.getByText('Import your notes').first()).toBeVisible({ timeout: 60_000 });
  const homeText = await page.locator('main').innerText();
  expect(homeText).not.toMatch(/record|audio|microphone|transcrib/i);

  // ---- New note > A document > Keep it as my note ----------------------------
  await configureAiProvider(page, { baseUrl: provider!.baseUrl, apiKey: 'sk-e2e-note-first-0123456789abcdef' });
  await page.goto(page.url().split('#')[0] + '#/notes/new');
  await page.getByRole('radio', { name: /A document/ }).check();
  await page.getByLabel('Choose a document').setInputFiles({
    name: 'planning.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: Buffer.from(DOCX),
  });
  await expect(page.getByRole('radio', { name: /Keep it as my note/ })).toBeChecked();
  await page.getByRole('button', { name: 'Import note' }).click();

  await page.waitForURL(/#\/notes\/(?!new)[^/?]+$/, { timeout: 300_000 });
  await expect(page.getByText(/Imported from/).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('planning.docx').first()).toBeVisible();
  // The original file can be downloaded again (marinoscar/kvox#732).
  await expect(page.getByRole('button', { name: 'Download planning.docx' })).toBeVisible();
});
