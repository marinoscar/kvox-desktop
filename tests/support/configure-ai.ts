import { expect, type Page } from '@playwright/test';

// =============================================================================
// The e2e step every AI flow starts with: Settings > AI provider (marinoscar/kvox#584)
// =============================================================================
//
// Points the app at an OpenAI-compatible server (the loopback mock of
// openai-compatible-mock.ts) and saves its key, through the settings page as a
// user would; on a Linux session with no keyring it first accepts plaintext key
// storage, without which the key is refused. Ends back on the notes library.
// =============================================================================

/** The text every mock answer carries, with the marker the specs look for. */
export const MOCK_NOTE_TEXT =
  '# Meeting notes\n\nGenerated on this device through the configured AI provider.\n\n- Joe sends the budget by Friday.\n- Desktop smoke marker: zebracorn.\n';

export async function configureAiProvider(page: Page, options: { baseUrl: string; apiKey: string; model?: string }): Promise<void> {
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'AI provider' })).toBeVisible();
  await page.getByRole('radio', { name: 'OpenAI-compatible server' }).check();
  await page.getByLabel('Base URL').fill(options.baseUrl);
  await page.getByLabel('Model').fill(options.model ?? 'mock-model');
  await page.getByRole('button', { name: 'Save AI settings' }).click();
  await expect(page.getByText('AI settings saved.')).toBeVisible();
  const plaintext = page.getByLabel('Store keys without system encryption on this device');
  if (await plaintext.isVisible()) {
    // Controlled by the main process's answer: click, then wait for the box to follow.
    await plaintext.click();
    await expect(plaintext).toBeChecked();
  }
  await page.getByLabel('API key', { exact: true }).fill(options.apiKey);
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(page.getByText('API key saved in the system keychain.')).toBeVisible();
  await page.getByRole('link', { name: 'Notes' }).click();
  await expect(page.getByRole('heading', { name: 'Notes', level: 1 })).toBeVisible();
}
