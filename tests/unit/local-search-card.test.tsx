// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { KvoxApiError, KvoxWebHostProvider, type KvoxWebHost } from '@marinoscar/kvox-web/core/headless';

import { LOCAL_SEARCH_POLL_INTERVAL_MS, LocalSearchCard, type LocalSearchStatus } from '../../src/renderer/src/settings/LocalSearchCard';

// =============================================================================
// "Semantic search on this device" (marinoscar/kvox#660)
// =============================================================================
//
// The page against a scripted host: `http.request` answers the local server's
// `/desktop/ai/local-search` routes and the search slice's index routes, and
// records every call. It proves the bindings: each state's controls, the
// consent body, the poll that runs only while downloading, cancel, the switch,
// remove behind a confirmation, retry after an error, and the unavailable build.
// =============================================================================

const BASE_STATUS: LocalSearchStatus = {
  enabled: false,
  active: false,
  consentedAt: null,
  state: 'missing',
  progress: null,
  error: null,
  model: 'bge-small-en-v1.5-int8',
  sizeBytes: 34_000_000,
  hosts: ['huggingface.co', 'cdn-lfs.hf.co'],
};

const READY_ON: LocalSearchStatus = { ...BASE_STATUS, enabled: true, active: true, consentedAt: '2026-10-01T00:00:00.000Z', state: 'ready', progress: 1 };
const READY_OFF: LocalSearchStatus = { ...READY_ON, enabled: false, active: false };

const INDEX_STATUS = {
  types: [
    { type: 'note', indexed: 12, pending: 3, failed: 0, skipped: 0, unindexed: 0, total: 15 },
    { type: 'transcript', indexed: 4, pending: 0, failed: 0, skipped: 0, unindexed: 0, total: 4 },
  ],
  model: 'bge-small-en-v1.5-int8',
  hasKey: true,
  available: true,
  reason: null,
  failures: [],
};

type Handler = (body: unknown) => unknown;
interface Call {
  method: string;
  path: string;
  body: unknown;
}

function scriptedHost(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const request = vi.fn(async (method: string, path: string, init?: { body?: unknown }) => {
    calls.push({ method, path, body: init?.body });
    const handler = routes[`${method} ${path}`];
    if (!handler) throw new Error(`unexpected ${method} ${path}`);
    return handler(init?.body);
  });
  const host = { http: { request }, viewer: () => ({ userId: 'local-user', permissions: new Set<string>() }) } as unknown as KvoxWebHost;
  return { host, calls };
}

function renderCard(host: KvoxWebHost) {
  return render(
    <KvoxWebHostProvider host={host}>
      <LocalSearchCard />
    </KvoxWebHostProvider>,
  );
}

const conflict = (code: string, text: string) => new KvoxApiError(text, 409, code);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('LocalSearchCard', () => {
  it('off and missing: explains, lists what happens, and consents with { consent: true }', async () => {
    let current: LocalSearchStatus = BASE_STATUS;
    const { host, calls } = scriptedHost({
      'GET /desktop/ai/local-search': () => current,
      'POST /desktop/ai/local-search/download': () => {
        current = { ...BASE_STATUS, enabled: true, consentedAt: 'now', state: 'downloading', progress: 0.25 };
        return current;
      },
    });
    renderCard(host);

    expect(await screen.findByText(/by meaning, not just by their exact words/)).toBeTruthy();
    expect(screen.getByText(/no API key/)).toBeTruthy();
    expect(screen.getByText(/one-time download of the bge-small-en-v1\.5-int8 model \(34 MB\) from Hugging Face \(huggingface\.co, cdn-lfs\.hf\.co\)/)).toBeTruthy();
    expect(screen.getByText(/verified by checksum/)).toBeTruthy();
    expect(screen.getByText(/not part of your backups/)).toBeTruthy();
    expect(screen.getByText(/nothing leaves this device/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Download and turn on' }));
    await screen.findByText(/25%/);
    const post = calls.find((call) => call.method === 'POST');
    expect(post).toEqual({ method: 'POST', path: '/desktop/ai/local-search/download', body: { consent: true } });
    expect(screen.getByRole('progressbar', { name: 'Model download progress' })).toBeTruthy();
  });

  it('downloading: shows progress, polls every second, and stops polling once ready', async () => {
    const answers: LocalSearchStatus[] = [
      { ...BASE_STATUS, enabled: true, state: 'downloading', progress: 0.1 },
      { ...BASE_STATUS, enabled: true, state: 'downloading', progress: 0.6 },
    ];
    const { host, calls } = scriptedHost({
      'GET /desktop/ai/local-search': () => answers.shift() ?? READY_ON,
      'GET /search/index-status': () => INDEX_STATUS,
    });
    renderCard(host);

    expect(await screen.findByText(/10%/)).toBeTruthy();
    expect(await screen.findByText(/60%/, {}, { timeout: 3000 })).toBeTruthy();
    expect(await screen.findByText('On — searching on this device', {}, { timeout: 3000 })).toBeTruthy();

    const readsAtReady = calls.filter((call) => call.path === '/desktop/ai/local-search').length;
    expect(readsAtReady).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, LOCAL_SEARCH_POLL_INTERVAL_MS * 2.5));
    expect(calls.filter((call) => call.path === '/desktop/ai/local-search').length).toBe(readsAtReady);
  }, 15_000);

  it('downloading: Cancel deletes the download and returns to the consent block', async () => {
    const { host, calls } = scriptedHost({
      'GET /desktop/ai/local-search': () => ({ ...BASE_STATUS, enabled: true, state: 'downloading', progress: 0.4 }),
      'DELETE /desktop/ai/local-search/download': () => BASE_STATUS,
    });
    renderCard(host);

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('button', { name: 'Download and turn on' })).toBeTruthy();
    expect(calls.some((call) => call.method === 'DELETE' && call.path === '/desktop/ai/local-search/download')).toBe(true);
  });

  it('ready and on: status, the slice\'s index counts and model, Index now, and the switch turns it off', async () => {
    const { host, calls } = scriptedHost({
      'GET /desktop/ai/local-search': () => READY_ON,
      'GET /search/index-status': () => INDEX_STATUS,
      'POST /search/index': () => ({ queued: 3, remaining: 0, cap: 200 }),
      'PATCH /desktop/ai/local-search': () => READY_OFF,
    });
    renderCard(host);

    expect(await screen.findByText('On — searching on this device')).toBeTruthy();
    expect(await screen.findByText('Notes: 12 indexed, 3 pending')).toBeTruthy();
    expect(screen.getByText('Transcripts: 4 indexed, 0 pending')).toBeTruthy();
    expect(screen.getByText('Model: bge-small-en-v1.5-int8')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Index now' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.path === '/search/index')).toBe(true));

    const toggle = screen.getByRole('switch', { name: 'Semantic search on this device' }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryByText('On — searching on this device')).toBeNull());
    expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({ enabled: false });
    expect((screen.getByRole('switch', { name: 'Semantic search on this device' }) as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByRole('button', { name: 'Index now' })).toBeNull();
  });

  it('ready and off: the switch turns it on, and a refusal is shown', async () => {
    let refuse = true;
    const { host, calls } = scriptedHost({
      'GET /desktop/ai/local-search': () => READY_OFF,
      'GET /search/index-status': () => INDEX_STATUS,
      'PATCH /desktop/ai/local-search': () => {
        if (refuse) throw conflict('model_not_ready', 'The on-device search model is not installed yet.');
        return READY_ON;
      },
    });
    renderCard(host);

    fireEvent.click(await screen.findByRole('switch', { name: 'Semantic search on this device' }));
    expect((await screen.findByRole('alert')).textContent).toContain('not installed yet');

    refuse = false;
    fireEvent.click(screen.getByRole('switch', { name: 'Semantic search on this device' }));
    expect(await screen.findByText('On — searching on this device')).toBeTruthy();
    expect(calls.filter((call) => call.method === 'PATCH').map((call) => call.body)).toEqual([{ enabled: true }, { enabled: true }]);
  });

  it('Remove model asks first; Keep it does nothing, Remove deletes the model', async () => {
    const { host, calls } = scriptedHost({
      'GET /desktop/ai/local-search': () => READY_OFF,
      'DELETE /desktop/ai/local-search': () => BASE_STATUS,
    });
    renderCard(host);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove model' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove the on-device model?' });
    expect(within(dialog).getByText(/frees about 34 MB/)).toBeTruthy();
    expect(within(dialog).getByText(/falls back to your AI provider, or to full-text search/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Remove model' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByRole('button', { name: 'Download and turn on' })).toBeTruthy();
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual(['/desktop/ai/local-search']);
  });

  it('error: shows why, and Try again consents again', async () => {
    let current: LocalSearchStatus = { ...BASE_STATUS, enabled: true, consentedAt: 'then', state: 'error', error: 'checksum_mismatch' };
    const { host, calls } = scriptedHost({
      'GET /desktop/ai/local-search': () => current,
      'POST /desktop/ai/local-search/download': () => {
        current = { ...current, state: 'downloading', progress: 0, error: null };
        return current;
      },
    });
    renderCard(host);

    expect((await screen.findByRole('alert')).textContent).toContain('checksum_mismatch');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({ consent: true });
  });

  it('a switch left on without a model (after a crash) asks for the download again', async () => {
    const { host } = scriptedHost({
      'GET /desktop/ai/local-search': () => ({ ...BASE_STATUS, enabled: true, consentedAt: 'then', state: 'missing' }),
    });
    renderCard(host);

    expect(await screen.findByRole('button', { name: 'Download and turn on' })).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('an action\'s failure is shown and the buttons come back', async () => {
    const { host } = scriptedHost({
      'GET /desktop/ai/local-search': () => BASE_STATUS,
      'POST /desktop/ai/local-search/download': () => {
        throw new KvoxApiError('The network is unreachable.', 500);
      },
    });
    renderCard(host);

    const button = await screen.findByRole('button', { name: 'Download and turn on' });
    fireEvent.click(button);
    expect((await screen.findByRole('alert')).textContent).toContain('The network is unreachable.');
    expect((screen.getByRole('button', { name: 'Download and turn on' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a build without the embedder shows one notice and nothing else (on read)', async () => {
    const { host } = scriptedHost({
      'GET /desktop/ai/local-search': () => {
        throw conflict('local_search_unavailable', 'On-device search is not available in this build.');
      },
    });
    renderCard(host);

    expect(await screen.findByText('On-device search is not available in this build.')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(/by meaning/)).toBeNull();
  });

  it('a build without the embedder shows the same notice when an action is refused', async () => {
    const { host } = scriptedHost({
      'GET /desktop/ai/local-search': () => BASE_STATUS,
      'POST /desktop/ai/local-search/download': () => {
        throw conflict('local_search_unavailable', 'On-device search is not available in this build.');
      },
    });
    renderCard(host);

    fireEvent.click(await screen.findByRole('button', { name: 'Download and turn on' }));
    expect(await screen.findByText('On-device search is not available in this build.')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
