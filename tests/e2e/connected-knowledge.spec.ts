import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

import type { KvoxDesktopBridge } from '../../src/shared/protocol';
import { MOCK_NOTE_TEXT, configureAiProvider, openSettingsCard } from '../support/configure-ai';
import { startOpenAiCompatibleMock, type OpenAiCompatibleMock } from '../support/openai-compatible-mock';

// =============================================================================
// Settings > Connected knowledge: the `ai.graphEnabled` switch (marinoscar/kvox#620)
// =============================================================================
//
// On the packaged app, with an AI provider configured (the loopback mock):
// connected knowledge starts on; switching it off hides Knowledge, Review and
// Ask, sends a knowledge link back to the notes, makes Ask answer 409
// `graph_disabled` without a call to the provider, and survives a restart;
// switching it on brings the destinations and the Ask composer back.
// =============================================================================

const ROOT = resolve(__dirname, '..', '..');
const userDataDir = mkdtempSync(join(tmpdir(), 'kvox-e2e-knowledge-'));
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

async function launch(): Promise<Page> {
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
  return page;
}

/** Posts a question to a new conversation with the window's own connection: the status and body. */
async function askOnce(page: Page): Promise<{ status: number; body: string }> {
  return page.evaluate(async () => {
    const bridge = (window as unknown as { kvoxDesktop: KvoxDesktopBridge }).kvoxDesktop;
    const { baseUrl, token } = await bridge.connection();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const created = await fetch(`${baseUrl}/api/ask/conversations`, { method: 'POST', headers, body: '{}' });
    const conversation = (await created.json()) as { id?: string; data?: { id: string } };
    const id = conversation.data?.id ?? conversation.id;
    const response = await fetch(`${baseUrl}/api/ask/conversations/${id}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: 'What are the action items from Joe?' }),
    });
    return { status: response.status, body: await response.text() };
  });
}

async function openSettings(page: Page) {
  await openSettingsCard(page, 'Connected knowledge');
  return page.getByLabel('Connected knowledge', { exact: true });
}

async function expectKnowledgeLinks(page: Page, visible: boolean) {
  for (const name of ['Knowledge', 'Review', 'Ask']) {
    const link = page.getByRole('link', { name, exact: true });
    if (visible) await expect(link).toBeVisible();
    else await expect(link).toHaveCount(0);
  }
}

test('connected knowledge can be switched off and on in Settings, and stays as set', async () => {
  test.setTimeout(600_000);
  let page = await launch();
  await configureAiProvider(page, { baseUrl: provider!.baseUrl, apiKey: 'sk-e2e-knowledge-0123456789abcdef' });

  // ---- On by default ---------------------------------------------------------
  await expectKnowledgeLinks(page, true);
  let toggle = await openSettings(page);
  await expect(toggle).toBeChecked();

  // ---- Off: the destinations go, Ask is refused before any provider call -----
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByRole('status').filter({ hasText: 'Connected knowledge is off' })).toBeVisible();
  await expectKnowledgeLinks(page, false);
  await page.goto(page.url().replace(/#.*$/, '#/ask'));
  await page.waitForURL(/#\/notes$/);
  await expect(page.getByRole('heading', { name: 'Notes', level: 1 })).toBeVisible();

  const before = provider!.requests.length;
  const refused = await askOnce(page);
  expect(refused.status).toBe(409);
  expect(refused.body).toContain('graph_disabled');
  expect(provider!.requests.length).toBe(before);

  // ---- A restart keeps it off -------------------------------------------------
  await app!.close();
  page = await launch();
  await expectKnowledgeLinks(page, false);
  toggle = await openSettings(page);
  await expect(toggle).not.toBeChecked();

  // ---- On again: the destinations and the composer come back ------------------
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expectKnowledgeLinks(page, true);
  await page.getByRole('link', { name: 'Ask', exact: true }).click();
  await expect(page.getByPlaceholder('Ask about your meetings, people and projects…')).toBeVisible();
  expect((await askOnce(page)).body).not.toContain('graph_disabled');
});
