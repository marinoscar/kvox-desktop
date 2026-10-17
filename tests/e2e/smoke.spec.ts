import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

// =============================================================================
// The D1 smoke test (marinoscar/kvox#582)
// =============================================================================
//
// Upload a Markdown file, generate a note with the fake AI, quit, start again
// on the same data folder and see the note; across both runs, no request may
// reach any host but 127.0.0.1.
//
// It drives the built app (`out/`, after `npm run build`) or, when
// KVOX_E2E_EXECUTABLE names one, an installed/unpacked app. It writes what it
// measured (cold start, idle memory) to test-results/metrics.json.
// =============================================================================

const ROOT = resolve(__dirname, '..', '..');
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
  await page.waitForURL(/#\/notes/, { timeout: 180_000 });
  await expect(page.getByRole('heading', { name: 'Notes', level: 1 })).toBeVisible({ timeout: 180_000 });
  const ms = Date.now() - started;
  metrics[`${label}LaunchToNotesMs`] = ms;
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

test.afterAll(async () => {
  await running?.close().catch(() => undefined);
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
  metrics.coldIdleMemoryMb = await idleMemory(first.app);
  await first.app.close();

  // ---- Second launch: same data folder ---------------------------------------
  const second = await launch('warm');
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
});
