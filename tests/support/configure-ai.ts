import { expect, type Page } from '@playwright/test';

import { goTo } from './rail';

// =============================================================================
// The e2e step every AI flow starts with: Settings > AI provider (marinoscar/kvox#584)
// =============================================================================
//
// Points the app at an OpenAI-compatible server (the loopback mock of
// openai-compatible-mock.ts) and saves its key, through the settings hub as a
// user would (the hub, then the AI provider card; marinoscar/kvox-desktop#19);
// on a Linux session with no keyring it first accepts plaintext key storage on
// the Data and privacy page (a typed confirmation), without which the key is
// refused. The key card verifies the key against the mock before storing it.
// Ends back on the notes library.
// =============================================================================

/** The text every mock answer carries, with the marker the specs look for. */
export const MOCK_NOTE_TEXT =
  '# Meeting notes\n\nGenerated on this device through the configured AI provider.\n\n- Joe sends the budget by Friday.\n- Desktop smoke marker: zebracorn.\n';

/** The phrase the plaintext-key confirmation asks for (DataPrivacyCard). */
const PLAINTEXT_PHRASE = 'PLAINTEXT KEYS';

/** Opens Settings (the hub) and then one card's page, as a user does. */
export async function openSettingsCard(page: Page, title: string): Promise<void> {
  // The rail's Settings item (a settings page also carries a "Settings" way back, which is not it).
  await goTo(page, 'Settings');
  await expect(page.getByRole('heading', { name: 'Settings', level: 4 })).toBeVisible();
  await page.getByRole('button', { name: new RegExp(`^${title}`) }).click();
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
}

/** On Linux with no keyring, accepts plaintext key storage through the typed confirmation. */
export async function acceptPlaintextKeysIfAsked(page: Page): Promise<void> {
  await openSettingsCard(page, 'Data and privacy');
  const plaintext = page.getByLabel('Store keys without system encryption on this device');
  // The card renders neither answer until the main process has reported the key storage: wait for one of
  // them, or a slow first paint reads as "no consent needed" and the key is then refused.
  const keychain = page.getByText(/Saved API keys are encrypted by the operating system keychain|offers no keychain/);
  await expect(plaintext.or(keychain)).toBeVisible();
  if (!(await plaintext.isVisible())) return;
  await plaintext.click();
  const dialog = page.getByRole('dialog', { name: 'Store keys without system encryption?' });
  await dialog.getByLabel('I understand my keys will not be encrypted.').check();
  await dialog.getByLabel(`Type ${PLAINTEXT_PHRASE} to confirm`).fill(PLAINTEXT_PHRASE);
  await dialog.getByRole('button', { name: 'Store keys' }).click();
  // Controlled by the main process's answer: wait for the box to follow.
  await expect(plaintext).toBeChecked();
}

export async function configureAiProvider(page: Page, options: { baseUrl: string; apiKey: string; model?: string }): Promise<void> {
  await openSettingsCard(page, 'AI provider');
  await page.getByRole('radio', { name: 'OpenAI-compatible server' }).check();
  await page.getByLabel('Base URL').fill(options.baseUrl);
  await page.getByLabel('Model').fill(options.model ?? 'mock-model');
  await page.getByRole('button', { name: 'Save AI settings' }).click();
  await expect(page.getByText('AI settings saved.')).toBeVisible();
  await acceptPlaintextKeysIfAsked(page);
  await openSettingsCard(page, 'AI provider');
  await page.getByLabel('API key', { exact: true }).fill(options.apiKey);
  await page.getByRole('button', { name: 'Save & verify' }).click();
  await expect(page.getByText('Key verified and saved.')).toBeVisible();
  await goTo(page, 'Notes');
  await expect(page.getByRole('heading', { name: 'Notes', level: 1 })).toBeVisible();
}
