import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

import type { KvoxDesktopBridge } from '../../src/shared/protocol';
import { MOCK_NOTE_TEXT, configureAiProvider } from '../support/configure-ai';
import { startOpenAiCompatibleMock, type OpenAiCompatibleMock } from '../support/openai-compatible-mock';

// =============================================================================
// Import from a native dialog and by drag and drop (marinoscar/kvox#585)
// =============================================================================
//
// Each input kind, through the packaged app, with the synthetic fixtures of
// tests/fixtures/import:
//
//   PDF transcript      dialog  -> "New note" with the document chosen, text read
//   transcript JSON     dialog  -> "New note" with the transcript chosen; named
//                                  speakers and recordedAt kept; a note generated
//   note export (.md)   drop    -> the note, same title and body as exported
//   Markdown            drop    -> "New note" with the document chosen
//   foreign JSON        dialog  -> the slice's own refusal, nothing opened
//
// The dialog is Electron's own `dialog.showOpenDialog`, answered with the
// fixture's path (a test cannot click a native dialog). The drop is Chromium's
// own (CDP `Input.dispatchDragEvent` with real file paths), so the preload reads
// the dropped file's path exactly as it does for a user. No request may reach a
// host other than 127.0.0.1. The AI provider is a loopback OpenAI-compatible
// mock, configured in Settings first (marinoscar/kvox#584).
// =============================================================================

const ROOT = resolve(__dirname, '..', '..');
const FIXTURES = join(ROOT, 'tests', 'fixtures', 'import');
const userDataDir = mkdtempSync(join(tmpdir(), 'kvox-e2e-import-'));
const requests: string[] = [];
const mainLog: string[] = [];
let app: ElectronApplication | undefined;
let provider: OpenAiCompatibleMock | undefined;

test.beforeAll(async () => {
  provider = await startOpenAiCompatibleMock(MOCK_NOTE_TEXT);
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await provider?.close();
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

/** Answers the next native open dialog with `paths`. */
async function answerDialogWith(application: ElectronApplication, paths: string[]): Promise<void> {
  await application.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths })) as typeof dialog.showOpenDialog;
  }, paths);
}

/** Drops real files on the window, as Chromium delivers a drop from the OS. */
async function dropFiles(application: ElectronApplication, page: Page, paths: string[]): Promise<void> {
  const cdp = await application.context().newCDPSession(page);
  const data = { items: [], files: paths, dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
    await cdp.send('Input.dispatchDragEvent', { type, x: 400, y: 300, data });
  }
  await cdp.detach();
}

/** GET on the local server with the window's own connection. */
async function apiGet<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(async (p) => {
    const bridge = (window as unknown as { kvoxDesktop: KvoxDesktopBridge }).kvoxDesktop;
    const { baseUrl, token } = await bridge.connection();
    const response = await fetch(`${baseUrl}/api${p}`, { headers: { Authorization: `Bearer ${token}` } });
    return (await response.json()) as never;
  }, path) as Promise<T>;
}

test('every input kind imports from the dialog or by drag and drop, with no egress', async () => {
  const executablePath = process.env.KVOX_E2E_EXECUTABLE;
  app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: [ROOT] }),
    env: { ...process.env, KVOX_USER_DATA_DIR: userDataDir },
    timeout: 120_000,
  });
  app.process().stdout?.on('data', (chunk: Buffer) => mainLog.push(...chunk.toString().split('\n').filter(Boolean)));
  app.process().stderr?.on('data', (chunk: Buffer) => mainLog.push(...chunk.toString().split('\n').filter(Boolean)));
  app.context().on('request', (request) => requests.push(request.url()));
  const page = await app.firstWindow();
  await expect(page.getByRole('heading', { name: 'Notes', level: 1 })).toBeVisible({ timeout: 180_000 });
  await configureAiProvider(page, { baseUrl: provider!.baseUrl, apiKey: 'sk-e2e-import-0123456789abcdef' });

  // ---- PDF transcript, from the dialog --------------------------------------
  await answerDialogWith(app, [join(FIXTURES, 'roadmap-sync-transcript.pdf')]);
  await page.getByRole('button', { name: 'Import…' }).click();
  await page.waitForURL(/#\/notes\/new\?objectId=/);
  await expect(page.getByRole('radio', { name: /A document/ })).toBeChecked();
  await expect(page.getByText('roadmap-sync-transcript.pdf')).toBeVisible();
  await expect(page.getByText('Document read')).toBeVisible();

  // ---- Transcript JSON, from the dialog: speakers and date kept, then a note --
  await page.goto(page.url().replace(/#.*$/, '#/notes'));
  await answerDialogWith(app, [join(FIXTURES, 'm03-roadmap-sync.transcript.json')]);
  await page.getByRole('button', { name: 'Import…' }).click();
  await page.waitForURL(/#\/notes\/new\?transcriptId=/);
  const transcriptId = decodeURIComponent(/transcriptId=([^&]+)/.exec(page.url())![1]);
  const transcript = await apiGet<{ recordedAt: string; speakers: Array<{ displayName: string }> }>(page, `/transcripts/${transcriptId}`);
  expect(transcript.speakers.map((speaker) => speaker.displayName)).toEqual(['Dana Example', 'Lee Ortiz', 'Speaker C']);
  expect(new Date(transcript.recordedAt).toISOString()).toBe('2026-03-04T15:00:00.000Z');
  await expect(page.getByRole('combobox', { name: 'Transcript' })).toContainText('M03 roadmap sync');
  await page.getByRole('button', { name: 'Generate' }).click();
  await page.waitForURL(/#\/notes\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Desktop smoke marker: zebracorn.')).toBeVisible();

  // ---- Note export, dropped on the window: same title and body ---------------
  const expected = JSON.parse(readFileSync(join(FIXTURES, 'planning-sync-note.expected.json'), 'utf8')) as { title: string; body: string };
  await page.goto(page.url().replace(/#.*$/, '#/notes'));
  await expect(page.getByRole('heading', { name: 'Notes', level: 1 })).toBeVisible();
  await dropFiles(app, page, [join(FIXTURES, 'planning-sync-note.md')]);
  await page.waitForURL(/#\/notes\/[0-9a-f-]{36}$/);
  const noteId = /#\/notes\/([0-9a-f-]{36})$/.exec(page.url())![1];
  await expect(page.getByRole('heading', { level: 1 }).first()).toHaveText(expected.title);
  await expect(page.getByText('Round-trip marker: tapirglow.')).toBeVisible();
  const note = await apiGet<{ title: string; body: string }>(page, `/notes/${noteId}`);
  expect(note).toMatchObject({ title: expected.title, body: expected.body });

  // ---- Markdown, dropped: a note source ------------------------------------
  await dropFiles(app, page, [join(FIXTURES, 'standup.md')]);
  await page.waitForURL(/#\/notes\/new\?objectId=/);
  await expect(page.getByText('Document read')).toBeVisible();

  // ---- A foreign JSON: the slice's own refusal, nothing opened ---------------
  await page.goto(page.url().replace(/#.*$/, '#/notes'));
  await answerDialogWith(app, [join(FIXTURES, 'foreign.json')]);
  await page.getByRole('button', { name: 'Import…' }).click();
  await expect(page.getByTestId('import-error')).toBeVisible();
  await expect(page.getByTestId('import-error')).not.toBeEmpty();
  expect(page.url()).toMatch(/#\/notes$/);

  // ---- No egress ------------------------------------------------------------
  const outside = requests.filter((url) => {
    const parsed = new URL(url);
    if (['kvox:', 'data:', 'blob:', 'devtools:', 'file:'].includes(parsed.protocol)) return false;
    return parsed.hostname !== '127.0.0.1';
  });
  expect(outside, 'requests to a host other than 127.0.0.1').toEqual([]);
  expect(mainLog.filter((line) => line.includes('egress blocked')), 'requests the egress guard cancelled').toEqual([]);
  // The main process logged each import by kind and status, never by file name.
  const importLines = mainLog.filter((line) => line.includes('import: '));
  expect(importLines.length).toBeGreaterThanOrEqual(5);
  expect(importLines.join('\n')).not.toMatch(/roadmap|planning|standup|m03|foreign/i);
});
