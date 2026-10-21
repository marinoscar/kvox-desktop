import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { openSettingsCard } from '../support/configure-ai';
import { goTo, railItem } from '../support/rail';
import {
  COPILOT_ACCEPT_LABEL,
  COPILOT_CONSENT_TITLE,
  COPILOT_DOWNLOAD_BUTTON,
  COPILOT_SIGN_IN_BUTTON,
  COPILOT_SIGN_IN_DIALOG,
  COPILOT_RADIO,
} from '../support/copilot-ui';

// =============================================================================
// GitHub Copilot in Settings, end to end (marinoscar/kvox-desktop#22)
// =============================================================================
//
// The app runs with KVOX_E2E_COPILOT_MOCK=1: the server (an unpackaged build only)
// swaps Copilot's runtime and transport for the packages' mock transport
// (`src/server/ai/copilot-e2e-host.ts`), so there is no GitHub, no SDK and no
// runtime download over the network. Everything else is the real app: consent,
// the runtime download (progress, Cancel), the sign-in device code, "Signed in
// as", a note generated on Copilot, an Ask turn answered on Copilot (one tool
// call through the adapter's tool bridge, then the answer), sign-out, switching off.
// No OpenAI key is saved, so every task runs on Copilot (search by meaning stays
// off: it needs embeddings, which Copilot does not offer); no request may leave
// the loopback. Copilot is chosen with the page's "AI provider" radio group: the
// consent first (Not now keeps OpenAI), then it is the provider until OpenAI is chosen again.
//
// It needs a display (CI has one; locally: xvfb-run) and the built app (`out/`).
// Against an installed app (KVOX_E2E_EXECUTABLE) it is skipped: the mock is for
// the unpackaged build only.
// =============================================================================

const ROOT = resolve(__dirname, '..', '..');
const userDataDir = mkdtempSync(join(tmpdir(), 'kvox-e2e-copilot-'));
const requests: string[] = [];
const mainLog: string[] = [];
let running: ElectronApplication | undefined;

test.skip(Boolean(process.env.KVOX_E2E_EXECUTABLE), 'the Copilot mock is for the unpackaged build only');

test.afterAll(async () => {
  await running?.close().catch(() => undefined);
  mkdirSync(join(ROOT, 'test-results'), { recursive: true });
  writeFileSync(join(ROOT, 'test-results', 'copilot-app.log'), `${mainLog.join('\n')}\n`);
  rmSync(userDataDir, { recursive: true, force: true });
});

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, KVOX_USER_DATA_DIR: userDataDir, KVOX_E2E_COPILOT_MOCK: '1' },
    timeout: 120_000,
  });
  running = app;
  app.process().stdout?.on('data', (chunk: Buffer) => mainLog.push(...chunk.toString().split('\n').filter(Boolean)));
  app.process().stderr?.on('data', (chunk: Buffer) => mainLog.push(...chunk.toString().split('\n').filter(Boolean)));
  app.context().on('request', (request) => requests.push(request.url()));
  const page = await app.firstWindow();
  await page.waitForURL(/#\/notes/, { timeout: 180_000 });
  await expect(page.getByRole('heading', { name: 'Notes', level: 1 })).toBeVisible({ timeout: 180_000 });
  return { app, page };
}

test('Copilot: consent, runtime download, sign-in, Ask and a note on Copilot, sign-out', async () => {
  const { app, page } = await launch();

  // The shell opens only what the allowlist lets through: stand in for the system browser.
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { __opened?: string[] }).__opened = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });

  // ---- OpenAI by default; Not now on the consent keeps it ------------------------
  await openSettingsCard(page, 'AI provider');
  const providers = page.getByRole('radiogroup', { name: 'AI provider' });
  const copilotRadio = providers.getByRole('radio', { name: COPILOT_RADIO });
  const openaiRadio = providers.getByRole('radio', { name: 'OpenAI', exact: true });
  const card = page.getByRole('region', { name: 'GitHub Copilot sign-in' });
  await expect(openaiRadio).toBeChecked();
  await expect(copilotRadio).not.toBeChecked();
  // Only the chosen provider's setup: no Copilot card while OpenAI is chosen.
  await expect(card).toHaveCount(0);
  await copilotRadio.click();
  const consent = page.getByRole('dialog', { name: COPILOT_CONSENT_TITLE });
  await expect(consent).toBeVisible();
  await consent.getByRole('button', { name: 'Not now' }).click();
  await expect(consent).toBeHidden();
  await expect(copilotRadio).not.toBeChecked();
  await expect(openaiRadio).toBeChecked();
  await expect(card).toHaveCount(0);

  // ---- Agree: Copilot becomes the provider ------------------------------------------
  await copilotRadio.click();
  await page.getByRole('dialog', { name: COPILOT_CONSENT_TITLE }).getByRole('button', { name: COPILOT_ACCEPT_LABEL }).click();
  await expect(copilotRadio).toBeChecked();
  await expect(page.getByRole('status').filter({ hasText: 'Using GitHub Copilot.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Set up GitHub Copilot' })).toBeVisible();
  await expect(card).toBeVisible();
  // The page offers the choice: the card has no switch of its own.
  await expect(page.getByLabel('Enable GitHub Copilot')).toHaveCount(0);
  // Signed out with no runtime yet: chosen, but not ready.
  await expect(providers.getByText('Needs setup')).toBeVisible();
  // The optional OpenAI key for search by meaning, under Copilot's own setup (Ask runs on Copilot).
  await expect(page.getByRole('heading', { name: 'Optional: an OpenAI key for search by meaning' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Optional: an OpenAI key for Ask' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'OpenAI key', exact: true })).toBeVisible();
  // The Copilot hosts appear in the one footer while it is the provider.
  await expect(page.getByText(/Besides this device, KVox may connect only to: .*api\.githubcopilot\.com/)).toHaveCount(1);

  // ---- The runtime is missing: size, Download, progress, Cancel ---------------
  await expect(card.getByText(/The Copilot runtime is not installed/)).toBeVisible();
  await card.getByRole('button', { name: COPILOT_DOWNLOAD_BUTTON }).click();
  await expect(card.getByText(/Downloading the Copilot runtime/)).toBeVisible();
  await expect(card.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await card.getByRole('button', { name: 'Cancel' }).click();
  await expect(card.getByRole('button', { name: COPILOT_DOWNLOAD_BUTTON })).toBeVisible();
  await card.getByRole('button', { name: COPILOT_DOWNLOAD_BUTTON }).click();
  await expect(card.getByText(/Downloading the Copilot runtime/)).toBeVisible();

  // ---- Ready: sign in with the device code -------------------------------------
  // (The sign-in button is shown during the download too, but needs the finished runtime.)
  await expect(card.getByText(/Downloading the Copilot runtime/)).toBeHidden();
  await expect(card.getByText(/The Copilot runtime is not installed/)).toBeHidden();
  await card.getByRole('button', { name: COPILOT_SIGN_IN_BUTTON }).click();
  const signIn = page.getByRole('dialog', { name: COPILOT_SIGN_IN_DIALOG });
  await expect(signIn.getByLabel(/Your code is ABCD-1234/)).toBeVisible();
  await expect(signIn.getByRole('button', { name: 'Copy code' })).toBeVisible();
  await signIn.getByRole('button', { name: 'Open GitHub' }).click();
  await expect.poll(() => app.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? [])).toEqual(['https://github.com/login/device']);

  // ---- Signed in, without a reload ----------------------------------------------
  await expect(card.getByText('Signed in as octocat')).toBeVisible();
  await expect(signIn).toBeHidden();
  await expect(card.getByRole('combobox', { name: 'Model' })).toBeVisible();
  await expect(providers.getByText('Ready')).toBeVisible();
  const capabilities = card.getByRole('list', { name: 'GitHub Copilot capabilities' });
  await expect(capabilities.getByRole('listitem').filter({ hasText: 'Notes' }).getByText('Available')).toBeVisible();
  await expect(capabilities.getByRole('listitem').filter({ hasText: 'Ask' }).getByText('Available')).toBeVisible();
  await expect(capabilities.getByRole('listitem').filter({ hasText: 'Ask' }).getByText('Not available')).toHaveCount(0);

  // ---- Ask runs on Copilot: no flag in the rail, and its click opens Ask ------------------
  await goTo(page, 'Notes');
  await goTo(page, 'Ask');
  await page.waitForURL(/#\/ask/);
  await expect(railItem(page, 'Ask').getByTestId('ask-unavailable')).toHaveCount(0);
  const question = page.getByPlaceholder('Ask about your meetings, people and projects…');
  await question.fill('What does Joe owe us?');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.waitForURL(/#\/ask\/[0-9a-f-]{36}/);
  // One `search` step through the tool bridge, then the answer, all on the mock Copilot.
  // (`E2E_COPILOT_ASK_TEXT` of src/server/ai/copilot-e2e-host.ts.)
  const answer = page.getByTestId('ask-answer');
  await expect(answer.getByText(/Answered on Copilot: copilotyak\./)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: /^Searched "budget"/ })).toBeVisible();
  await goTo(page, 'Notes');

  // ---- A note, generated on Copilot ---------------------------------------------
  await page.getByRole('button', { name: 'New note' }).filter({ visible: true }).first().click();
  await expect(page.getByRole('heading', { name: 'New note' })).toBeVisible();
  await page.getByRole('radio', { name: /A document/ }).check();
  await page.getByLabel('Choose a document').setInputFiles({
    name: 'standup.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Stand-up\n\nJoe will send the budget by Friday.\nJenny reviews the plan.\n'),
  });
  await expect(page.getByText('Document read')).toBeVisible();
  await page.getByRole('button', { name: 'Generate' }).click();
  await page.waitForURL(/#\/notes\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Generated on Copilot: copilotzebra.')).toBeVisible();

  // ---- Still the provider after a visit elsewhere; sign out; then OpenAI removes the hosts ----
  await openSettingsCard(page, 'AI provider');
  await expect(copilotRadio).toBeChecked();
  await card.getByRole('button', { name: 'Sign out' }).click();
  await expect(card.getByRole('button', { name: COPILOT_SIGN_IN_BUTTON })).toBeVisible();
  await expect(card.getByText(/Signed in as/)).toHaveCount(0);
  await expect(providers.getByText('Needs setup')).toBeVisible();
  await openaiRadio.click();
  await expect(openaiRadio).toBeChecked();
  await expect(page.getByRole('status').filter({ hasText: 'Using OpenAI.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Set up OpenAI', exact: true })).toBeVisible();
  // Back to the one host of OpenAI; the Copilot hosts and the Copilot card are gone.
  await expect(page.getByText('KVox may connect only to: api.openai.com')).toBeVisible();
  await expect(page.getByText(/api\.githubcopilot\.com/)).toHaveCount(0);
  await expect(card).toHaveCount(0);

  // ---- Nothing left the device ------------------------------------------------------
  const outside = requests.filter((url) => {
    const parsed = new URL(url);
    if (['kvox:', 'data:', 'blob:', 'devtools:'].includes(parsed.protocol)) return false;
    return parsed.hostname !== '127.0.0.1';
  });
  expect(outside, 'requests to a host other than 127.0.0.1').toEqual([]);
  expect(mainLog.filter((line) => line.includes('egress blocked')), 'requests the egress guard cancelled').toEqual([]);
});
