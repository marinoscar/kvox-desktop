import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { MOCK_NOTE_TEXT, configureAiProvider, openSettingsCard } from '../support/configure-ai';
import { expectRail, goTo, homeHeading, rail, railItem, userMenuButton, useWideWindow } from '../support/rail';
import { COPILOT_CONSENT_TITLE, COPILOT_RADIO } from '../support/copilot-ui';
import { startOpenAiCompatibleMock, type OpenAiCompatibleMock } from '../support/openai-compatible-mock';

// =============================================================================
// The D1 smoke test (marinoscar/kvox#582)
// =============================================================================
//
// Configure the AI provider in Settings (an OpenAI-compatible server: a loopback
// mock speaking Chat Completions, marinoscar/kvox#584) and save its key, upload a
// Markdown file, generate a note through the real provider adapter, quit, start
// again on the same data folder and see the note; across both runs, no request
// may reach any host but 127.0.0.1, and the planted key is in no log line and in
// no file of the data folder (only the keychain-encrypted blob holds it).
//
// It drives the built app (`out/`, after `npm run build`) or, when
// KVOX_E2E_EXECUTABLE names one, an installed/unpacked app. It writes what it
// measured (cold start, idle memory) to test-results/metrics.json.
// =============================================================================

const ROOT = resolve(__dirname, '..', '..');
const PLANTED_KEY = 'sk-e2e-PLANTEDkvox584DoNotLeak0123456789';
let provider: OpenAiCompatibleMock | undefined;
const userDataDir = mkdtempSync(join(tmpdir(), 'kvox-e2e-'));
const requests: string[] = [];
const mainLog: string[] = [];
const metrics: Record<string, unknown> = { platform: process.platform, arch: process.arch };
let running: ElectronApplication | undefined;

async function launch(label: string): Promise<{ app: ElectronApplication; page: Page; ms: number }> {
  const started = Date.now();
  const executablePath = process.env.KVOX_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: [ROOT] }),
    env: { ...process.env, KVOX_USER_DATA_DIR: userDataDir },
    timeout: 120_000,
  });
  running = app;
  app.process().stdout?.on('data', (chunk: Buffer) => mainLog.push(...chunk.toString().split('\n').filter(Boolean)));
  app.process().stderr?.on('data', (chunk: Buffer) => mainLog.push(...chunk.toString().split('\n').filter(Boolean)));
  app.context().on('request', (request) => requests.push(request.url()));
  const page = await app.firstWindow();
  // The window opens on Home (marinoscar/kvox-desktop#47).
  await page.waitForURL(/#\/$/, { timeout: 180_000 });
  await expect(homeHeading(page)).toBeVisible({ timeout: 180_000 });
  const ms = Date.now() - started;
  metrics[`${label}LaunchToHomeMs`] = ms;
  await useWideWindow(app, page);
  // The checks below start from the notes library.
  await goTo(page, 'Notes');
  await page.waitForURL(/#\/notes$/);
  return { app, page, ms };
}

async function idleMemory(app: ElectronApplication): Promise<Record<string, number>> {
  await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
  const processes = await app.evaluate(({ app: electronApp }) =>
    electronApp.getAppMetrics().map((m) => ({ type: m.type, name: m.name ?? m.serviceName ?? '', kb: m.memory.workingSetSize })),
  );
  const byType: Record<string, number> = {};
  for (const p of processes) {
    const key = p.type === 'Utility' ? `Utility:${p.name}` : p.type;
    byType[key] = Math.round(((byType[key] ?? 0) + p.kb / 1024) * 10) / 10;
  }
  byType.totalMb = Math.round((processes.reduce((sum, p) => sum + p.kb, 0) / 1024) * 10) / 10;
  return byType;
}

test.beforeAll(async () => {
  provider = await startOpenAiCompatibleMock(MOCK_NOTE_TEXT);
});

test.afterAll(async () => {
  await running?.close().catch(() => undefined);
  await provider?.close();
  mkdirSync(join(ROOT, 'test-results'), { recursive: true });
  metrics.mainLog = mainLog.filter((line) => line.startsWith('[kvox]'));
  writeFileSync(join(ROOT, 'test-results', 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
  // Everything the app printed (main and server), for a failed run's artifact.
  writeFileSync(join(ROOT, 'test-results', 'app.log'), `${mainLog.join('\n')}\n`);
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

test('a note generated from a Markdown file survives a restart, with no egress', async () => {
  // ---- First launch: empty data folder, every migration applied ----------------
  const first = await launch('cold');
  const { page } = first;

  // ---- The application menu (marinoscar/kvox-desktop#20) -------------------------
  // Triggered through Electron's own menu, as a click would: New note navigates, Toggle light/dark switches
  // the theme; Reload and DevTools exist only in an app that is not packaged; no item opens a link.
  const clickMenuItem = (label: string) =>
    first.app.evaluate(({ Menu }, wanted) => {
      const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
        for (const item of items) {
          if (item.label === wanted) return item;
          const inner = item.submenu ? find(item.submenu.items) : undefined;
          if (inner) return inner;
        }
        return undefined;
      };
      const item = find(Menu.getApplicationMenu()?.items ?? []);
      if (!item) throw new Error(`no menu item "${wanted}"`);
      item.click();
    }, label);
  const menuInfo = await first.app.evaluate(({ Menu, app: electronApp }) => {
    const roles: string[] = [];
    const labels: string[] = [];
    const walk = (items: Electron.MenuItem[]) => {
      for (const item of items) {
        roles.push(String(item.role ?? ''));
        labels.push(item.label);
        if (item.submenu) walk(item.submenu.items);
      }
    };
    walk(Menu.getApplicationMenu()?.items ?? []);
    return { roles, labels, isPackaged: electronApp.isPackaged };
  });
  for (const label of ['New note', 'Import…', 'Settings', 'Toggle light/dark', 'About KVox', 'Open data folder', 'View licences']) {
    expect(menuInfo.labels, label).toContain(label);
  }
  const developerRoles = ['reload', 'forcereload', 'toggledevtools'].map((role) => menuInfo.roles.map((r) => r.toLowerCase()).includes(role));
  expect(developerRoles, 'Reload and Developer Tools exist only while unpackaged').toEqual([!menuInfo.isPackaged, !menuInfo.isPackaged, !menuInfo.isPackaged]);
  // ---- The KVox theme (marinoscar/kvox-desktop#17) ---------------------------------
  // The look is @marinoscar/kvox-web/brand's through ShellRoot; the values below are the issue's. Pixels are
  // asserted as computed styles (a screenshot baseline would be a per-OS binary), and the screenshots are
  // attached to the report for the eye.
  const DARK_GROUND = 'rgb(15, 17, 23)';
  const LIGHT_GROUND = 'rgb(246, 247, 251)';
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const windowBackground = () => first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase());
  // The shell's own toggle (marinoscar/kvox-desktop#18): light <-> dark.
  const toggleTheme = () => page.getByRole('button', { name: 'toggle theme' }).click();
  const attachScreenshot = async (name: string) =>
    test.info().attach(name, { body: await page.screenshot(), contentType: 'image/png' });

  // Inter, from the app bundle; sentence-case buttons; the primary indigo.
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/^"?Inter"?,/);
  expect(await page.evaluate(() => document.fonts.load('16px Inter').then(() => document.fonts.check('16px Inter')))).toBe(true);
  const newNote = page.getByRole('button', { name: 'New note' }).filter({ visible: true }).first();
  expect(await newNote.evaluate((el) => getComputedStyle(el).textTransform)).toBe('none');

  // System follows the OS.
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(background).toBe(LIGHT_GROUND);
  // (MUI buttons transition their colours, so these are polled.)
  await expect.poll(() => newNote.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(79, 70, 229)');
  await attachScreenshot('notes-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(background).toBe(DARK_GROUND);
  await expect
    .poll(() => newNote.evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color]))
    .toEqual(['rgb(165, 180, 252)', DARK_GROUND]);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(background).toBe(LIGHT_GROUND);

  // The application menu's Toggle light/dark goes through ShellRoot (light -> dark -> light), and the
  // window's own background follows the page.
  await clickMenuItem('Toggle light/dark');
  await expect.poll(background).toBe(DARK_GROUND);
  await expect.poll(windowBackground).toBe('#0f1117');
  await clickMenuItem('Toggle light/dark');
  await expect.poll(background).toBe(LIGHT_GROUND);
  await expect.poll(windowBackground).toBe('#f6f7fb');

  // The app bar's toggle (the shell's): light -> dark -> light.
  await toggleTheme();
  await expect.poll(background).toBe(DARK_GROUND);
  await toggleTheme();
  await expect.poll(background).toBe(LIGHT_GROUND);

  // ---- The shell (marinoscar/kvox-desktop#18) ---------------------------------------
  // KvoxAppShell, as on KVox web: a left rail of icons and labels (Home, Notes, Knowledge, Review, Ask; Settings
  // pinned at the foot, no Templates: it is a Settings card), the KVox name in the app bar, and a user menu
  // with the two desktop rows and no sign-out. Rail items are found by role and name.
  await expectRail(page, ['Home', 'Notes', 'Knowledge', 'Review', 'Ask', 'Settings']);
  await expect(railItem(page, 'Notes')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('header').getByText('KVox', { exact: true })).toBeVisible();
  for (const [name, path] of [
    ['Knowledge', /#\/graph$/],
    ['Review', /#\/graph\/review$/],
    ['Ask', /#\/ask$/],
    ['Settings', /#\/settings$/],
    ['Notes', /#\/notes$/],
    ['Home', /#\/$/],
  ] as const) {
    await goTo(page, name);
    await page.waitForURL(path);
    await expect(railItem(page, name)).toHaveAttribute('aria-current', 'page');
  }
  await userMenuButton(page).click();
  const userMenu = page.getByRole('menu');
  await expect(userMenu.getByRole('menuitem', { name: 'Open data folder' })).toBeVisible();
  await expect(userMenu.getByRole('menuitem', { name: 'About KVox' })).toBeVisible();
  await expect(userMenu.getByRole('menuitem', { name: /log ?out|sign ?out/i })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(userMenu).toHaveCount(0);
  await attachScreenshot('shell-rail');
  await clickMenuItem('New note');
  await page.waitForURL(/#\/notes\/new$/);
  await expect(page.getByRole('heading', { name: 'New note' })).toBeVisible();
  await clickMenuItem('Settings');
  await page.waitForURL(/#\/settings$/);
  await goTo(page, 'Notes');

  // ---- Settings: the hub of five cards, then the provider, its model, its key ----
  await goTo(page, 'Settings');
  await expect(page.getByRole('heading', { name: 'Settings', level: 4 })).toBeVisible();
  for (const title of ['AI provider', 'Connected knowledge', 'Note Templates', 'Data and privacy', 'Updates']) {
    await expect(page.getByRole('button', { name: new RegExp(`^${title}`) })).toBeVisible();
  }
  // Templates is a card of the hub, not a top-bar entry.
  await expect(page.getByRole('link', { name: 'Templates', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /^Note Templates/ }).click();
  await expect(page.getByRole('heading', { name: 'Note Templates', level: 1 })).toBeVisible();
  await goTo(page, 'Settings');
  await page.getByRole('button', { name: /^AI provider/ }).click();
  await expect(page.getByRole('heading', { name: 'AI provider', level: 1 })).toBeVisible();
  await expect(page.getByText('KVox may connect only to: api.openai.com')).toBeVisible();
  // One choice of three, never off: OpenAI by default, only its setup shown.
  const providers = page.getByRole('radiogroup', { name: 'AI provider' });
  await expect(providers.getByRole('radio')).toHaveCount(3);
  await expect(providers.getByRole('radio', { name: 'OpenAI', exact: true })).toBeChecked();
  await expect(providers.getByRole('radio', { name: /off/i })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Set up OpenAI', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save AI settings' })).toHaveCount(0);
  // Choosing Copilot asks for the consent first, and "Not now" puts the radio back on OpenAI
  // (accepting, the download, the sign-in and a note on Copilot are in copilot.spec.ts).
  const copilotRadio = providers.getByRole('radio', { name: COPILOT_RADIO });
  await expect(copilotRadio).not.toBeChecked();
  await copilotRadio.click();
  const consent = page.getByRole('dialog', { name: COPILOT_CONSENT_TITLE });
  await expect(consent).toBeVisible();
  await consent.getByRole('button', { name: 'Not now' }).click();
  await expect(consent).toBeHidden();
  await expect(copilotRadio).not.toBeChecked();
  await expect(providers.getByRole('radio', { name: 'OpenAI', exact: true })).toBeChecked();
  await expect(page.getByText('KVox may connect only to: api.openai.com')).toBeVisible();
  await configureAiProvider(page, { baseUrl: provider!.baseUrl, apiKey: PLANTED_KEY });
  await openSettingsCard(page, 'AI provider');
  await expect(page.getByText('KVox connects to nothing outside this device.')).toBeVisible();
  // The key is masked (its last four characters), the field is empty, and the key is never sent back.
  const keyCard = page.getByRole('region', { name: 'OpenAI-compatible server key' });
  await expect(keyCard).toContainText(`…${PLANTED_KEY.slice(-4)}`);
  await expect(keyCard.getByLabel('Replace API key')).toHaveValue('');
  // Test key: the server asks the mock provider (verifyKey) and answers a verdict, never the key.
  await keyCard.getByRole('button', { name: 'Re-check' }).click();
  await expect(keyCard.getByText('The key works')).toBeVisible();
  await expect(keyCard.getByText('1 model available with this key')).toBeVisible();
  expect(await keyCard.innerText()).not.toContain(PLANTED_KEY);
  await goTo(page, 'Notes');

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
  const noteId = /#\/notes\/([0-9a-f-]{36})$/.exec(page.url())![1];
  await expect(page.getByText('Desktop smoke marker: zebracorn.')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 }).first()).not.toHaveText('');
  // ---- Dark: the card, and the choice that has to survive the restart -----------------
  await goTo(page, 'Notes');
  await toggleTheme();
  await expect.poll(background).toBe(DARK_GROUND);
  await attachScreenshot('notes-dark');
  await goTo(page, 'Settings');
  await expect(page.locator('.MuiCard-root').first()).toBeVisible();
  // Polled: the hub re-renders as it settles, and a computed style read from a node that has just been
  // replaced is empty.
  await expect
    .poll(() =>
      page
        .locator('.MuiCard-root')
        .first()
        .evaluate((el) => {
          const style = getComputedStyle(el);
          return { backgroundColor: style.backgroundColor, borderTopWidth: style.borderTopWidth, boxShadow: style.boxShadow };
        }),
    )
    .toEqual({ backgroundColor: 'rgb(23, 26, 35)', borderTopWidth: '1px', boxShadow: 'none' });
  await attachScreenshot('settings-dark');
  await goTo(page, 'Notes');
  // The rail collapses and the choice is kept in the shell settings (shell.railCollapsed), to be there on the next launch.
  await rail(page).getByRole('button', { name: 'Collapse navigation' }).click();
  await expect(rail(page).getByRole('button', { name: 'Expand navigation' })).toBeVisible();
  await expect
    .poll(() => (JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')) as { shell?: { railCollapsed?: boolean } }).shell?.railCollapsed)
    .toBe(true);
  // The shell keeps a copy in settings.json, which is what paints the window before the page exists.
  await expect
    .poll(() => (JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')) as { themeMode?: string }).themeMode)
    .toBe('dark');
  metrics.coldIdleMemoryMb = await idleMemory(first.app);
  await first.app.close();

  // ---- Second launch: same data folder ---------------------------------------
  const second = await launch('warm');
  // The dark choice survived the restart: the page paints in it and the window was created in it.
  await expect.poll(() => second.page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(15, 17, 23)');
  expect(await second.page.evaluate(() => localStorage.getItem('theme_mode'))).toBe('dark');
  expect(await second.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase())).toBe('#0f1117');
  test.info().attach('notes-dark-after-restart', { body: await second.page.screenshot(), contentType: 'image/png' });
  // The rail is still collapsed (the destinations stay reachable, by name), and expands again.
  await expect(rail(second.page).getByRole('button', { name: 'Expand navigation' })).toBeVisible();
  await expect(railItem(second.page, 'Settings')).toBeVisible();
  await rail(second.page).getByRole('button', { name: 'Expand navigation' }).click();
  await expect(rail(second.page).getByRole('button', { name: 'Collapse navigation' })).toBeVisible();
  await expect
    .poll(() => (JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')) as { shell?: { railCollapsed?: boolean } }).shell?.railCollapsed)
    .toBe(false);
  // The library lists the note with its generated body; opening it shows the note. (Not by the title read in
  // the first run: the heading shows the template's name until the generated title replaces it.)
  await second.page.getByRole('button').filter({ hasText: 'Desktop smoke marker: zebracorn.' }).first().click();
  await second.page.waitForURL(new RegExp(`#/notes/${noteId}$`));
  await expect(second.page.getByText('Desktop smoke marker: zebracorn.')).toBeVisible();
  metrics.warmIdleMemoryMb = await idleMemory(second.app);
  await second.app.close();

  // ---- No egress -------------------------------------------------------------
  const outside = requests.filter((url) => {
    const parsed = new URL(url);
    if (['kvox:', 'data:', 'blob:', 'devtools:'].includes(parsed.protocol)) return false;
    return parsed.hostname !== '127.0.0.1';
  });
  metrics.requestCount = requests.length;
  expect(outside, 'requests to a host other than 127.0.0.1').toEqual([]);
  expect(mainLog.filter((line) => line.includes('egress blocked')), 'requests the egress guard cancelled').toEqual([]);
  expect(requests.some((url) => url.startsWith('http://127.0.0.1:'))).toBe(true);
  expect(mainLog.some((line) => line.includes('server: egress allowlist is loopback only'))).toBe(true);

  // ---- The key reached the provider, and nothing else -------------------------
  const generations = provider!.requests.filter((r) => r.path.endsWith('/chat/completions'));
  expect(generations.length).toBeGreaterThan(0);
  expect(generations.every((r) => r.authorization === `Bearer ${PLANTED_KEY}`)).toBe(true);
  expect(mainLog.join('\n')).not.toContain('PLANTEDkvox584');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(userDataDir);
  const holding = files.filter((file) => readFileSync(file).includes(Buffer.from('PLANTEDkvox584')));
  expect(holding, 'files of the data folder holding the key in the clear').toEqual([]);
});
