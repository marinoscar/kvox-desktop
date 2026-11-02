import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

import type { KvoxDesktopBridge } from '../../src/shared/protocol';
import { MOCK_NOTE_TEXT, configureAiProvider } from '../support/configure-ai';
import { goTo, homeHeading, railItem } from '../support/rail';
import { startOpenAiCompatibleMock, type OpenAiCompatibleMock } from '../support/openai-compatible-mock';
import { QUESTIONS, scriptedModel } from '../support/scripted-model';

// =============================================================================
// The knowledge graph and Ask in Desktop: the reference questions (marinoscar/kvox#586)
// =============================================================================
//
// The epic's v1 acceptance bar (marinoscar/kvox#574), through the built app and
// its real AI path (KVOX_AI -> the platform's OpenAI-compatible adapter -> a
// loopback Chat Completions server), on the synthetic meetings of
// tests/fixtures/graph:
//
//   import each transcript (JSON, named speakers) -> generate its note -> the
//   graph extracts it (kg.extract) -> Review: open the proposal, accept all,
//   "Send to graph" -> Ask:
//
//   (The MANUAL review path: since kvox 0.1.0-next.23 the confident rows of a
//   proposal commit by themselves (`review.autoCommitSafeRows`, on by default,
//   marinoscar/kvox#779), so the test turns that preference off first, through
//   `PATCH /api/user-settings` as the Knowledge graph settings page does.)
//     "What are the action items from Joe?"            search -> list_commitments
//     "What meetings have we had with Jenny's boss?"   search -> neighbors(REPORTS_TO) -> timeline
//   -> each answer names the right commitment / meeting and cites it.
//
// Then the manual edit: no meeting says whom Priya Shah reports to, so the third
// question has no answer until "Set manager" on her entity page says Mark Chen.
//
// Also checked: every meeting has its ATTENDED rows from the named speakers (the
// D4 leftover); the explorer's G6 canvas mounts with nodes and its zoom-in and
// fit buttons work with no console error and no CSP violation; the graph exports as Turtle and that file imports back through
// SHACL validation (run in a utility process: the RunAsNode fuse is off); and
// no request reaches a host but 127.0.0.1. The model is
// scripted (`tests/support/scripted-model.ts`, over the package's own scripted
// model); a run with a live key is the manual check recorded on the issue.
// =============================================================================

const ROOT = resolve(__dirname, '..', '..');
const FIXTURES = join(ROOT, 'tests', 'fixtures', 'graph');
const MEETINGS = [
  { file: 'g01-weekly-sync.transcript.json', title: 'Weekly sync with Maria Lopez', speakers: ['Jenny Kim', 'Joe Park', 'Maria Lopez'] },
  { file: 'g02-standup.transcript.json', title: 'Joe and Jenny standup', speakers: ['Jenny Kim', 'Joe Park'] },
  { file: 'g03-platform-review.transcript.json', title: 'Data platform review with Mark Chen', speakers: ['Mark Chen', 'Priya Shah'] },
] as const;
const userDataDir = mkdtempSync(join(tmpdir(), 'kvox-e2e-graph-'));
const requests: string[] = [];
const mainLog: string[] = [];
const results: Record<string, unknown> = {};
const consoleErrors: string[] = [];
/** Every console error of the window, in order (the explorer check reads the ones logged after it starts). */
const allConsoleErrors: string[] = [];
let app: ElectronApplication | undefined;
let provider: OpenAiCompatibleMock | undefined;

interface AskAnswer {
  status: string;
  content: string;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown>; summary: string; error: string | null }>;
  citations: Array<{ marker: string; kind: string; valid: boolean; label: string; via: { kind: string } | null }>;
}

test.beforeAll(async () => {
  provider = await startOpenAiCompatibleMock(MOCK_NOTE_TEXT, scriptedModel());
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await provider?.close();
  mkdirSync(join(ROOT, 'test-results'), { recursive: true });
  writeFileSync(join(ROOT, 'test-results', 'graph-ask.json'), `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(join(ROOT, 'test-results', 'graph-ask-app.log'), `${mainLog.join('\n')}\n`);
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

/** Answers the next native open dialog with `paths`. */
async function answerDialogWith(application: ElectronApplication, paths: string[]): Promise<void> {
  await application.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths })) as typeof dialog.showOpenDialog;
  }, paths);
}

/** A request on the local server with the window's own connection (the `{ data }` envelope unwrapped). */
async function api<T>(
  page: Page,
  path: string,
  init: { method?: string; json?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  return page.evaluate(
    async ({ p, method, json, extraHeaders }) => {
      const bridge = (window as unknown as { kvoxDesktop: KvoxDesktopBridge }).kvoxDesktop;
      const { baseUrl, token } = await bridge.connection();
      const response = await fetch(`${baseUrl}/api${p}`, {
        method: method ?? 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(json === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...extraHeaders,
        },
        ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${method ?? 'GET'} ${p}: ${response.status} ${text}`);
      const body = text === '' ? null : JSON.parse(text);
      return body && typeof body === 'object' && 'data' in body && Object.keys(body).length <= 2 ? body.data : body;
    },
    { p: path, method: init.method, json: init.json, extraHeaders: init.headers ?? {} },
  ) as Promise<T>;
}

/** Turns off the automatic commit of confident rows (#779) for the local user, as the settings page does. */
async function useManualReview(page: Page): Promise<void> {
  const { version } = await api<{ version: number }>(page, '/user-settings');
  await api(page, '/user-settings', {
    method: 'PATCH',
    headers: { 'If-Match': String(version) },
    json: { graph: { review: { minConfidence: 0.7, autoCommitSafeRows: false } } },
  });
  const saved = await api<{ graph?: { review?: { autoCommitSafeRows?: boolean } } }>(page, '/user-settings');
  expect(saved.graph?.review?.autoCommitSafeRows).toBe(false);
}

/**
 * The graph explorer on the whole graph (its landing view, `GET /graph/overview?edges=true`): the G6
 * canvas mounts with nodes, and its on-screen zoom-in and fit buttons (kvox-web's `ZoomControls`)
 * run with no console error and no CSP violation.
 */
async function checkExplorerCanvas(page: Page): Promise<void> {
  const firstError = allConsoleErrors.length;
  // A violation is also a console error; the event names the directive, which the console text may not.
  await page.evaluate(() => {
    const w = window as unknown as { __cspViolations?: string[] };
    w.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      w.__cspViolations!.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  // The commits queued the map's layout (`kg.graph_layout`): the whole-graph view draws its snapshot.
  const overview = await until(
    () => api<{ status: string; nodeCount: number }>(page, '/graph/overview'),
    (o) => o.status === 'ready' && o.nodeCount > 0,
    'the graph map (kg.graph_layout)',
    180_000,
  );
  await page.goto(page.url().split('#')[0] + '#/graph/explore');
  await page.waitForURL(/#\/graph\/explore$/);

  // The pane names its node count; the canvas G6 drew into is inside it.
  const pane = page.getByRole('application', { name: /^Graph explorer, \d+ nodes\./ });
  await expect(pane).toBeVisible();
  await expect(pane).not.toHaveAttribute('aria-busy', 'true');
  await expect(pane).not.toHaveAccessibleName(/^Graph explorer, 0 nodes\./);
  const nodes = Number(/(\d+) nodes/.exec((await pane.getAttribute('aria-label')) ?? '')?.[1] ?? 0);
  expect(nodes, 'nodes on the explorer canvas').toBeGreaterThan(0);
  const surface = pane.getByTestId('graph-canvas');
  await expect(surface.locator('canvas').first()).toBeAttached();
  const size = await surface.locator('canvas').first().evaluate((c: HTMLCanvasElement) => ({ width: c.width, height: c.height }));
  expect(size.width).toBeGreaterThan(0);
  expect(size.height).toBeGreaterThan(0);

  // The camera cluster: zoom in, then fit.
  const zoom = pane.getByRole('group', { name: 'Canvas zoom' });
  await expect(zoom).toBeVisible();
  await zoom.getByRole('button', { name: 'Zoom in' }).click();
  await zoom.getByRole('button', { name: 'Fit to screen' }).click();
  // The canvas is still there after both, with its nodes.
  await expect(surface.locator('canvas').first()).toBeAttached();
  await expect(pane).not.toHaveAccessibleName(/^Graph explorer, 0 nodes\./);

  results.explorer = { nodes, mapNodes: overview.nodeCount, canvas: size };
  const violations = await page.evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? []);
  expect(violations, 'CSP violations in the explorer').toEqual([]);
  expect(allConsoleErrors.slice(firstError), 'console errors in the explorer').toEqual([]);
}

/** Polls `read` until `done` holds (the job loop runs in the background). */
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value).slice(0, 500)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Import -> note -> extraction -> Review: accept all -> Send to graph. Answers the note id. */
async function importAndCommit(page: Page, meeting: (typeof MEETINGS)[number]): Promise<string> {
  await goTo(page, 'Notes');
  await page.waitForURL(/#\/notes$/);
  await answerDialogWith(app!, [join(FIXTURES, meeting.file)]);
  await page.getByRole('button', { name: 'Import…' }).click();
  await page.waitForURL(/#\/notes\/new\?transcriptId=/);
  await expect(page.getByRole('combobox', { name: 'Transcript' })).toContainText(meeting.title);
  await page.getByRole('button', { name: 'Generate' }).click();
  await page.waitForURL(/#\/notes\/[0-9a-f-]{36}$/);
  const noteId = /#\/notes\/([0-9a-f-]{36})$/.exec(page.url())![1];
  await expect(page.getByText('Desktop smoke marker: zebracorn.')).toBeVisible();

  // A ready note is extracted on its own (`autoExtract`): wait for the draft, then review it.
  await until(
    () => api<{ proposal: { proposal: { status: string } } | null }>(page, `/graph/notes/${noteId}/proposal`).catch(() => null),
    (detail) => detail?.proposal?.proposal?.status === 'draft',
    `the draft proposal of "${meeting.title}"`,
  );
  // The note page read "no proposal" before the extraction started and does not poll for one
  // (marinoscar/kvox#616): reload, then open the review sheet from the note's graph button.
  await page.reload();
  await expect(page.getByText('Desktop smoke marker: zebracorn.')).toBeVisible();
  const send = page.getByRole('button', { name: /^Send to graph \(\d+\)$/ });
  const sheet = page.getByRole('button', { name: /^Graph proposal/ }).first();
  await expect(sheet).toBeVisible();
  if ((await sheet.getAttribute('aria-expanded')) !== 'true') await sheet.click();
  await expect(send).toBeVisible();
  // Rows the slice prechecks are accepted already; accept whatever group is still undecided.
  const accept = page.getByRole('button', { name: /^Accept all / });
  for (const button of await accept.all()) if (await button.isEnabled()) await button.click();
  await expect(send).toBeEnabled();
  await send.click();
  await until(
    () => api<{ proposal: { proposal: { status: string } } | null }>(page, `/graph/notes/${noteId}/proposal`),
    (detail) => detail?.proposal?.proposal?.status === 'committed',
    `the commit of "${meeting.title}"`,
  );
  return noteId;
}

/** Asks in the Ask page, waits for the turn and answers the stored assistant message. */
async function ask(page: Page, question: string, key: string = question): Promise<AskAnswer> {
  await goTo(page, 'Ask');
  const box = page.getByPlaceholder('Ask about your meetings, people and projects…');
  await expect(box).toBeVisible();
  await box.fill(question);
  await page.getByRole('button', { name: 'Send' }).click();
  await page.waitForURL(/#\/ask\/[0-9a-f-]{36}/);
  const conversationId = /#\/ask\/([0-9a-f-]{36})/.exec(page.url())![1];
  const detail = await until(
    () => api<{ messages: { items?: AskAnswer[] } | AskAnswer[] }>(page, `/ask/conversations/${conversationId}`),
    (d) => {
      const messages = (Array.isArray(d.messages) ? d.messages : (d.messages.items ?? [])) as Array<AskAnswer & { role: string }>;
      return messages.some((m) => m.role === 'assistant' && (m.status === 'complete' || m.status === 'failed'));
    },
    `the answer to "${question}"`,
  );
  const messages = (Array.isArray(detail.messages) ? detail.messages : (detail.messages.items ?? [])) as Array<AskAnswer & { role: string }>;
  const answer = messages.filter((m) => m.role === 'assistant').at(-1)!;
  results[key] = {
    status: answer.status,
    content: answer.content,
    toolCalls: answer.toolCalls.map((c) => ({ name: c.name, summary: c.summary, error: c.error })),
    citations: answer.citations.map((c) => ({ kind: c.kind, label: c.label, valid: c.valid, via: c.via?.kind ?? null })),
  };
  return answer;
}

test('the reference questions are answered with citations, and a manager set by hand answers the third', async () => {
  // Three imports, notes and extractions, four Ask turns and an RDF round trip, on the packaged app.
  test.setTimeout(900_000);
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
  // A blocked request (CORS) is a console error: none may happen.
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    allConsoleErrors.push(message.text().slice(0, 300));
    if (/CORS|blocked/i.test(message.text())) consoleErrors.push(message.text().slice(0, 300));
  });
  page.on('pageerror', (error) => allConsoleErrors.push(`pageerror: ${error.message.slice(0, 300)}`));
  await expect(homeHeading(page)).toBeVisible({ timeout: 180_000 });
  await configureAiProvider(page, { baseUrl: provider!.baseUrl, apiKey: 'sk-e2e-graph-0123456789abcdef' });
  // This scenario walks the manual review: no proposal may commit by itself.
  await useManualReview(page);

  // ---- Import, extract, review, commit: the three meetings ------------------
  for (const meeting of MEETINGS) await importAndCommit(page, meeting);

  // ---- The graph: one entity per person, a Meeting per transcript ----------
  const persons = await api<{ items: Array<{ id: string; label: string }> }>(page, '/graph/entities?type=Person');
  expect(persons.items.map((e) => e.label).sort()).toEqual(['Jenny Kim', 'Joe Park', 'Maria Lopez', 'Mark Chen', 'Priya Shah']);
  const person = new Map(persons.items.map((e) => [e.label, e.id]));
  const meetings = await api<{ items: Array<{ id: string; label: string }> }>(page, '/graph/entities?type=Meeting');
  expect(meetings.items.map((e) => e.label).sort()).toEqual(MEETINGS.map((m) => m.title).sort());

  // ---- The rail reaches the graph destinations (the shell, marinoscar/kvox-desktop#18) ----
  await goTo(page, 'Knowledge');
  await page.waitForURL(/#\/graph$/);
  await expect(railItem(page, 'Knowledge')).toHaveAttribute('aria-current', 'page');
  await goTo(page, 'Review');
  await page.waitForURL(/#\/graph\/review$/);
  await expect(railItem(page, 'Review')).toHaveAttribute('aria-current', 'page');
  await expect(railItem(page, 'Knowledge')).not.toHaveAttribute('aria-current', 'page');

  // ---- The explorer's canvas (G6, kvox-web 0.1.0-next.23) --------------------
  await checkExplorerCanvas(page);

  // ---- ATTENDED from the named speakers (the D4 leftover) ------------------
  const attended: Record<string, string[]> = {};
  for (const meeting of meetings.items) {
    const hood = await api<{ nodes: Array<{ id: string; label: string }>; edges: Array<{ type: string; source: string; target: string }> }>(
      page,
      `/graph/entities/${meeting.id}/neighborhood?relationTypes=ATTENDED`,
    );
    const label = new Map(hood.nodes.map((n) => [n.id, n.label]));
    attended[meeting.label] = hood.edges
      .filter((e) => e.type === 'ATTENDED')
      .map((e) => label.get(e.source) ?? '?')
      .sort();
  }
  results.attended = attended;
  for (const meeting of MEETINGS) expect(attended[meeting.title], `ATTENDED of "${meeting.title}"`).toEqual([...meeting.speakers]);

  // ---- "What are the action items from Joe?" -------------------------------
  const actionItems = await ask(page, QUESTIONS.actionItems);
  expect(actionItems.status).toBe('complete');
  expect(actionItems.toolCalls.map((c) => c.name)).toEqual(['search', 'list_commitments']);
  expect(actionItems.toolCalls.every((c) => c.error === null)).toBe(true);
  expect(actionItems.content).toContain('Send the budget draft');
  expect(actionItems.content).not.toContain('vendor review');
  expect(actionItems.citations.length).toBeGreaterThan(0);
  expect(actionItems.citations.every((c) => c.valid)).toBe(true);
  expect(actionItems.citations.find((c) => c.kind === 'entity')?.label).toBe('Joe Park');
  expect(actionItems.citations.filter((c) => c.kind === 'evidence').map((c) => c.label)).toEqual([MEETINGS[0].title]);
  // The answer streamed into the page (no reload), its citation chip naming the meeting.
  const thread = page.getByRole('region', { name: 'Conversation' });
  await expect(thread.getByText('Send the budget draft').first()).toBeVisible();
  await expect(thread.getByRole('button', { name: `Source 1: ${MEETINGS[0].title}` })).toBeVisible();

  // ---- "What meetings have we had with Jenny's boss?" ----------------------
  const bossMeetings = await ask(page, QUESTIONS.bossMeetings);
  expect(bossMeetings.status).toBe('complete');
  expect(bossMeetings.toolCalls.map((c) => c.name)).toEqual(['search', 'neighbors', 'timeline']);
  expect(bossMeetings.toolCalls.every((c) => c.error === null)).toBe(true);
  expect(bossMeetings.toolCalls[2].summary).toContain('Maria Lopez');
  expect(bossMeetings.content).toContain('Maria Lopez');
  expect(bossMeetings.content).toContain(MEETINGS[0].title);
  expect(bossMeetings.content).not.toContain(MEETINGS[1].title);
  expect(bossMeetings.citations.every((c) => c.valid)).toBe(true);
  expect(bossMeetings.citations.some((c) => c.via?.kind === 'relation')).toBe(true);
  expect(bossMeetings.citations.filter((c) => c.kind === 'evidence').every((c) => c.label === MEETINGS[0].title)).toBe(true);

  // ---- No meeting says whom Priya reports to --------------------------------
  const before = await ask(page, QUESTIONS.manualBossMeetings, `${QUESTIONS.manualBossMeetings} (before the manual edit)`);
  expect(before.content).not.toContain(MEETINGS[2].title);

  // ---- Set her manager by hand on her entity page ---------------------------
  await page.goto(page.url().split('#')[0] + `#/graph/entities/${person.get('Priya Shah')}`);
  await expect(page.getByRole('heading', { name: 'Priya Shah', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Set manager' }).click();
  const dialog = page.getByRole('dialog', { name: 'Set manager' });
  await dialog.getByRole('combobox', { name: 'Manager' }).fill('Mark');
  await page.getByRole('option', { name: /Mark Chen/ }).click();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove Reports to Mark Chen' })).toBeVisible();

  const manual = await ask(page, QUESTIONS.manualBossMeetings);
  expect(manual.status).toBe('complete');
  expect(manual.toolCalls.map((c) => c.name)).toEqual(['search', 'neighbors', 'timeline']);
  expect(manual.toolCalls.every((c) => c.error === null)).toBe(true);
  expect(manual.content).toContain('Mark Chen');
  expect(manual.content).toContain(MEETINGS[2].title);
  expect(manual.citations.every((c) => c.valid)).toBe(true);
  expect(manual.citations.some((c) => c.via?.kind === 'relation')).toBe(true);
  // The manager came from the user, and the answer says so.
  expect(manual.citations.some((c) => c.kind === 'evidence' && c.label === 'Set by hand' && c.via?.kind === 'relation')).toBe(true);

  // ---- RDF export, and the SHACL-validated import (a utility process) -------
  const created = await api<{ export: { id: string } }>(page, '/graph/exports', { method: 'POST', json: { format: 'turtle' } });
  const exported = await until(
    () => api<{ status: string; downloadUrl: string | null; stats: Record<string, number> }>(page, `/graph/exports/${created.export.id}`),
    (e) => e.status === 'ready' || e.status === 'failed',
    'the Turtle export',
  );
  expect(exported.status).toBe('ready');
  results.export = exported.stats;
  const imported = await page.evaluate(async (downloadUrl) => {
    const bridge = (window as unknown as { kvoxDesktop: KvoxDesktopBridge }).kvoxDesktop;
    const { baseUrl, token } = await bridge.connection();
    const auth = { Authorization: `Bearer ${token}` };
    const turtle = await (await fetch(downloadUrl.startsWith('http') ? downloadUrl : `${baseUrl}${downloadUrl}`, { headers: auth })).text();
    const form = new FormData();
    form.append('file', new Blob([turtle], { type: 'text/turtle' }), 'graph.ttl');
    const response = await fetch(`${baseUrl}/api/graph/imports`, { method: 'POST', headers: auth, body: form });
    const body = await response.json();
    return { status: response.status, proposalId: (body.data ?? body).proposalId as string, mentionsMark: turtle.includes('Mark Chen') };
  }, exported.downloadUrl!);
  expect(imported.status).toBe(202);
  expect(imported.mentionsMark).toBe(true);
  const importProposal = await until(
    () => api<{ proposal: { status: string } }>(page, `/graph/proposals/${imported.proposalId}`),
    (p) => p.proposal.status !== 'extracting',
    'the SHACL-validated import',
  );
  // Validated and staged for review: nothing entered the graph without a commit.
  expect(importProposal.proposal.status).toBe('draft');
  results.import = importProposal.proposal.status;

  // ---- No egress -------------------------------------------------------------
  const outside = requests.filter((url) => {
    const parsed = new URL(url);
    if (['kvox:', 'data:', 'blob:', 'devtools:', 'file:'].includes(parsed.protocol)) return false;
    return parsed.hostname !== '127.0.0.1';
  });
  expect(outside, 'requests to a host other than 127.0.0.1').toEqual([]);
  expect(consoleErrors, 'requests the window refused (CORS)').toEqual([]);
  expect(mainLog.filter((line) => line.includes('egress blocked')), 'requests the egress guard cancelled').toEqual([]);
  expect(mainLog.filter((line) => /job .* failed|kg\.\w+ failed/i.test(line)), 'failed graph jobs').toEqual([]);
});
