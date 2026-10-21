import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { KVOX_LOCAL_EMBEDDING } from '@marinoscar/kvox-ai';
import { LOCAL_EMBEDDING_DOWNLOAD_HOSTS, LOCAL_EMBEDDING_MANIFEST } from '@marinoscar/kvox-ai/local-embeddings';
import type { KvoxAiPort } from '@marinoscar/kvox-api/ports';
import { SEARCH_EMBED_FEATURE } from '@marinoscar/kvox-api/search';

import { EmbedderBroker, type EmbedderChild } from '../../src/main/embedder-broker';
import { createEmbedderHost } from '../../src/main/embedder-host';
import { unpackedRuntimeFile } from '../../src/main/embedder-paths';
import type { EmbedderRequest, EmbedderResponse, FromServer } from '../../src/shared/protocol';
import {
  AI_KEY_PURPOSE,
  DEFAULT_DESKTOP_AI_SETTINGS,
  DESKTOP_AI_NAMESPACE,
  DESKTOP_AI_SETTINGS_NAMESPACE,
  allowedHostsFor,
  desktopAiSettingsSchema,
} from '../../src/server/ai/desktop-ai-settings';
import { DesktopAi, loadProviderAdapters, type DesktopAiAdapters } from '../../src/server/ai/desktop-ai';
import { LOCAL_EMBEDDING_SIZE_BYTES, LocalEmbeddingsService, type LocalEmbeddingsDownloader } from '../../src/server/ai/local-embeddings';
import { LOCAL_EMBEDDING_FEATURE, createRoutedKvoxAi } from '../../src/server/ai/routed-kvox-ai';
import { DesktopAiController } from '../../src/server/desktop-ai.controller';
import { EgressGuard } from '../../src/server/egress-guard';
import { MainBridge } from '../../src/server/main-bridge';
import { PgSettings } from '../../src/server/ports/pg-settings';
import { SafeStorageSecrets } from '../../src/server/ports/safe-storage-secrets';
import { LOCAL_USER_ID } from '../../src/server/seed';
import { fakeCipher, openTestDatabase, removeQuietly, type TestDatabase } from './support/database';

// =============================================================================
// On-device semantic search (marinoscar/kvox#660): everything but the model itself
// =============================================================================
//
//   routing        search.embed goes on-device only while enabled AND installed;
//                  graph.embed and every other call never do
//   service        missing / downloading / ready / error, single flight, cancel, remove
//   settings       back-compatible schema, the egress widening
//   endpoints      consent required, 409 before the model is ready, the whole flow
//   main process   the broker (lazy fork, idle kill, death), the embedder host, the bridge
//
// The real model is exercised by tests/unit/local-search-e2e.test.ts.
// =============================================================================

/** Lets pending promise callbacks run. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

// ---- Routing ---------------------------------------------------------------------

describe('routing search.embed', () => {
  const portNamed = (name: string): KvoxAiPort =>
    ({
      capabilities: async () => ({ marker: name }),
      resolveTask: async () => ({ marker: name }),
      embed: async () => ({ marker: name }),
    }) as unknown as KvoxAiPort;
  const ctx = (feature: string) => ({ userId: 'u', orgId: null, feature }) as never;

  function routed(active: boolean | Promise<boolean>, withLocal = true) {
    return createRoutedKvoxAi({
      primary: portNamed('primary'),
      copilot: portNamed('copilot'),
      serving: async () => 'primary',
      copilotProviderId: 'copilot',
      ...(withLocal ? { local: { port: portNamed('local'), active: () => active } } : {}),
    });
  }

  it('names the search slice\'s own feature', () => {
    expect(LOCAL_EMBEDDING_FEATURE).toBe(SEARCH_EMBED_FEATURE);
  });

  it('serves search.embed capabilities and embeddings on-device only while enabled and ready', async () => {
    const on = routed(true);
    expect(await on.capabilities(ctx('search.embed'))).toEqual({ marker: 'local' });
    expect(await on.embed(ctx('search.embed'), { inputs: ['x'] } as never)).toEqual({ marker: 'local' });

    const off = routed(false);
    expect(await off.capabilities(ctx('search.embed'))).toEqual({ marker: 'primary' });
    expect(await off.embed(ctx('search.embed'), { inputs: ['x'] } as never)).toEqual({ marker: 'primary' });
  });

  it('never sends graph.embed or any other feature on-device', async () => {
    const on = routed(true);
    for (const feature of ['graph.embed', 'notes.generate', 'ask.respond', 'kg.extract']) {
      expect(await on.capabilities(ctx(feature)), feature).toEqual({ marker: 'primary' });
    }
    expect(await on.embed(ctx('graph.embed'), { inputs: ['x'] } as never)).toEqual({ marker: 'primary' });
    expect(await on.resolveTask(ctx('search.embed'), 'notes.generate')).toEqual({ marker: 'primary' });
  });

  it('is exactly today\'s routing without a local port', async () => {
    const plain = routed(true, false);
    expect(await plain.capabilities(ctx('search.embed'))).toEqual({ marker: 'primary' });
    expect(await plain.embed(ctx('search.embed'), { inputs: ['x'] } as never)).toEqual({ marker: 'primary' });
  });
});

// ---- The model's lifecycle -------------------------------------------------------

/** A downloader whose download the test finishes, fails or lets be cancelled. */
function fakeDownloader(directory: string) {
  const state = { installed: false, removed: 0, downloads: 0 };
  let finish: (() => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  const modelPath = join(directory, KVOX_LOCAL_EMBEDDING.model);
  const downloader: LocalEmbeddingsDownloader = {
    download: vi.fn(async (options) => {
      state.downloads += 1;
      options.onProgress?.(25, 100);
      await new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
        options.signal?.addEventListener('abort', () => reject(new Error('The download was cancelled')));
      });
      state.installed = true;
      return { path: modelPath };
    }),
    status: async () => (state.installed ? { installed: true, path: modelPath } : { installed: false }),
    remove: vi.fn(async () => {
      state.installed = false;
      state.removed += 1;
    }),
  };
  return {
    downloader,
    state,
    modelPath,
    finish: () => finish?.(),
    fail: (message: string) => fail?.(new Error(message)),
  };
}

describe('LocalEmbeddingsService', () => {
  const directory = '/models';

  it('derives its state from the files on start', async () => {
    const fake = fakeDownloader(directory);
    const missing = new LocalEmbeddingsService({ directory, downloader: fake.downloader });
    await missing.init();
    expect(missing.snapshot()).toEqual({ state: 'missing', progress: null, error: null });
    expect(missing.ready).toBe(false);

    fake.state.installed = true;
    const ready = new LocalEmbeddingsService({ directory, downloader: fake.downloader });
    await ready.init();
    expect(ready.snapshot()).toEqual({ state: 'ready', progress: 1, error: null });
    expect(ready.modelPath).toBe(fake.modelPath);
  });

  it('is single flight, reports progress, and settles to ready', async () => {
    const fake = fakeDownloader(directory);
    const settled: string[] = [];
    const service = new LocalEmbeddingsService({ directory, downloader: fake.downloader, onDownloadSettled: (state) => settled.push(state) });
    service.startDownload();
    service.startDownload();
    service.startDownload();
    await tick();
    expect(fake.downloader.download).toHaveBeenCalledTimes(1);
    expect(service.snapshot()).toEqual({ state: 'downloading', progress: 0.25, error: null });
    expect(service.downloading).toBe(true);
    fake.finish();
    await service.settled();
    expect(service.snapshot()).toEqual({ state: 'ready', progress: 1, error: null });
    expect(service.downloading).toBe(false);
    expect(settled).toEqual(['ready']);
    service.startDownload(); // already installed: nothing to do
    expect(fake.downloader.download).toHaveBeenCalledTimes(1);
  });

  it('cancels at once, ignores the late result, and can start again', async () => {
    const fake = fakeDownloader(directory);
    const settled: string[] = [];
    const service = new LocalEmbeddingsService({ directory, downloader: fake.downloader, onDownloadSettled: (state) => settled.push(state) });
    service.startDownload();
    await tick();
    service.cancelDownload();
    expect(service.state).toBe('missing');
    service.startDownload(); // while the cancelled one is still settling
    expect(service.state).toBe('downloading');
    await tick();
    await tick();
    expect(fake.downloader.download).toHaveBeenCalledTimes(2);
    // The cancelled download settling did not tell the caller to drop the hosts under the new one.
    expect(settled).toEqual([]);
    fake.finish();
    await service.settled();
    expect(service.state).toBe('ready');
    expect(settled).toEqual(['ready']);
  });

  it('reports a failure with its message and allows a retry', async () => {
    const fake = fakeDownloader(directory);
    const settled: string[] = [];
    const service = new LocalEmbeddingsService({ directory, downloader: fake.downloader, onDownloadSettled: (state) => settled.push(state) });
    service.startDownload();
    await tick();
    fake.fail('The network went away');
    await service.settled();
    expect(service.snapshot()).toEqual({ state: 'error', progress: null, error: 'The network went away' });
    expect(settled).toEqual(['error']);
    service.startDownload();
    await tick();
    expect(service.state).toBe('downloading');
    expect(service.snapshot().error).toBeNull();
    service.cancelDownload();
    await service.settled();
  });

  it('removes the model, cancelling a download first', async () => {
    const fake = fakeDownloader(directory);
    const service = new LocalEmbeddingsService({ directory, downloader: fake.downloader });
    service.startDownload();
    await tick();
    await service.remove();
    expect(service.state).toBe('missing');
    expect(fake.state.removed).toBe(1);
    expect(service.downloading).toBe(false);

    fake.state.installed = true;
    await service.init();
    expect(service.ready).toBe(true);
    await service.remove();
    expect(service.state).toBe('missing');
    expect(service.modelPath).toBeNull();
    expect(fake.state.removed).toBe(2);
  });
});

// ---- Settings --------------------------------------------------------------------

describe('the localSearch setting', () => {
  it('parses settings stored before it existed to off, without consent', () => {
    const { localSearch: _omitted, ...stored } = DEFAULT_DESKTOP_AI_SETTINGS;
    expect(desktopAiSettingsSchema.parse(stored).localSearch).toEqual({ enabled: false, consentedAt: null });
    expect(desktopAiSettingsSchema.parse({ ...stored, localSearch: {} }).localSearch).toEqual({ enabled: false, consentedAt: null });
    expect(DEFAULT_DESKTOP_AI_SETTINGS.localSearch).toEqual({ enabled: false, consentedAt: null });
  });

  it('keeps what the user set', () => {
    const parsed = desktopAiSettingsSchema.parse({ ...DEFAULT_DESKTOP_AI_SETTINGS, localSearch: { enabled: true, consentedAt: '2026-10-21T00:00:00.000Z' } });
    expect(parsed.localSearch).toEqual({ enabled: true, consentedAt: '2026-10-21T00:00:00.000Z' });
  });

  it('widens the egress allowlist for the model download only while it runs', () => {
    const base = allowedHostsFor(DEFAULT_DESKTOP_AI_SETTINGS);
    expect(base).toEqual(['api.openai.com']);
    const during = allowedHostsFor(DEFAULT_DESKTOP_AI_SETTINGS, { modelDownload: true });
    expect(during).toEqual(['api.openai.com', ...LOCAL_EMBEDDING_DOWNLOAD_HOSTS]);
    expect(allowedHostsFor({ ...DEFAULT_DESKTOP_AI_SETTINGS, provider: 'copilot' }, { modelDownload: true })).toEqual([...LOCAL_EMBEDDING_DOWNLOAD_HOSTS]);
    expect(allowedHostsFor(DEFAULT_DESKTOP_AI_SETTINGS, { modelDownload: false })).toEqual(base);
  });
});

// ---- DesktopAi and its endpoints, over a real settings table -------------------------

describe('on-device search through DesktopAi and its endpoints', () => {
  let db: TestDatabase;
  let settings: PgSettings;
  let secrets: SafeStorageSecrets;
  let providers: DesktopAiAdapters;
  let modelDirectory: string;
  const principal = { userId: LOCAL_USER_ID, orgId: null } as never;
  const created: DesktopAi[] = [];

  beforeAll(async () => {
    db = await openTestDatabase();
    settings = new PgSettings(db.prisma);
    settings.registerNamespace({
      scope: 'system',
      name: 'ai',
      schema: z.object({
        maxInputTokens: z.number().nullable(),
        maxOutputTokens: z.number().nullable(),
        maxDocumentBytes: z.number(),
        graphEnabled: z.boolean().default(true),
      }),
      defaults: { maxInputTokens: null, maxOutputTokens: null, maxDocumentBytes: 10 * 1024 * 1024, graphEnabled: true },
    });
    settings.registerNamespace(DESKTOP_AI_SETTINGS_NAMESPACE);
    secrets = new SafeStorageSecrets({ file: join(db.userDataDir, 'secrets.bin'), cipher: fakeCipher(), log: () => undefined });
    secrets.registerPurpose(AI_KEY_PURPOSE, 'AI provider API keys');
    providers = await loadProviderAdapters();
    modelDirectory = mkdtempSync(join(tmpdir(), 'kvox-models-'));
  });

  afterAll(async () => {
    await db?.close();
    removeQuietly(modelDirectory);
  });

  beforeEach(async () => {
    await settings.patchSystem(DESKTOP_AI_NAMESPACE, { ...DEFAULT_DESKTOP_AI_SETTINGS, localSearch: { enabled: false, consentedAt: null } }, { actorUserId: LOCAL_USER_ID });
  });

  afterEach(async () => {
    await Promise.all(created.splice(0).map((ai) => ai.close()));
  });

  function setup(options: { installed?: boolean } = {}) {
    const fake = fakeDownloader(modelDirectory);
    fake.state.installed = options.installed ?? false;
    const hosts: string[][] = [];
    const embedded: Array<{ modelPath: string; texts: string[] }> = [];
    const activated: number[] = [];
    const egress = new EgressGuard({ logError: () => undefined });
    const ai = new DesktopAi({
      settings,
      secrets,
      adapters: providers.adapters,
      onAllowedHosts: (list) => {
        hosts.push(list);
        egress.allow(list);
      },
      localSearch: {
        directory: modelDirectory,
        downloader: fake.downloader,
        embed: async (modelPath, texts) => {
          embedded.push({ modelPath, texts });
          return texts.map((text) => {
            const vector = new Array<number>(384).fill(0);
            vector[text.length % 384] = 1;
            return vector;
          });
        },
        onActive: () => void activated.push(Date.now()),
      },
    });
    created.push(ai);
    return { ai, fake, hosts, embedded, activated, egress, controller: new DesktopAiController(ai.port, ai, egress) };
  }

  it('is off, and the primary provider serves search, until the user consents and the model is installed', async () => {
    const { ai, controller } = setup();
    await ai.start();
    expect(await controller.localSearchStatus()).toEqual({
      enabled: false,
      active: false,
      consentedAt: null,
      state: 'missing',
      progress: null,
      error: null,
      model: KVOX_LOCAL_EMBEDDING.model,
      sizeBytes: LOCAL_EMBEDDING_SIZE_BYTES,
      hosts: [...LOCAL_EMBEDDING_DOWNLOAD_HOSTS],
    });
    expect(LOCAL_EMBEDDING_SIZE_BYTES).toBe(LOCAL_EMBEDDING_MANIFEST.files.reduce((sum, file) => sum + file.size, 0));
    const capabilities = await ai.port.capabilities({ userId: LOCAL_USER_ID, orgId: null, feature: 'search.embed' });
    expect(capabilities.embeddings?.model).not.toBe(KVOX_LOCAL_EMBEDDING.model);
  });

  it('refuses the download without consent, writing nothing and reaching nothing', async () => {
    const { ai, controller, fake, hosts } = setup();
    await ai.start();
    for (const body of [undefined, {}, { consent: false }, { consent: 'yes' }, null]) {
      await expect(controller.localSearchDownload(principal, body), JSON.stringify(body)).rejects.toMatchObject({
        status: 409,
        response: { code: 'consent_required', details: { sizeBytes: LOCAL_EMBEDDING_SIZE_BYTES, hosts: [...LOCAL_EMBEDDING_DOWNLOAD_HOSTS] } },
      });
    }
    expect(fake.downloader.download).not.toHaveBeenCalled();
    expect(hosts).toEqual([]);
    expect((await ai.read()).localSearch).toEqual({ enabled: false, consentedAt: null });
  });

  it('answers 409 when switching on before the model is installed, on either route', async () => {
    const { ai, controller } = setup();
    await ai.start();
    await expect(controller.localSearchUpdate(principal, { enabled: true })).rejects.toMatchObject({ status: 409, response: { code: 'consent_required' } });
    await expect(controller.patch(principal, { localSearch: { enabled: true } })).rejects.toMatchObject({ status: 409 });
    // Consent alone (a stored setting) is not enough: the model must be there.
    await settings.patchSystem(DESKTOP_AI_NAMESPACE, { localSearch: { consentedAt: '2026-10-21T00:00:00.000Z' } }, { actorUserId: LOCAL_USER_ID });
    await expect(controller.localSearchUpdate(principal, { enabled: true })).rejects.toMatchObject({ status: 409, response: { code: 'model_not_ready' } });
    await expect(controller.localSearchUpdate(principal, { enabled: 'yes' })).rejects.toMatchObject({ status: 400 });
    expect((await ai.read()).localSearch.enabled).toBe(false);
  });

  it('runs the whole flow: consent, download under a widened allowlist, serve search on-device, switch off, remove', async () => {
    const { ai, controller, fake, hosts, embedded, activated, egress } = setup();
    await ai.start();
    expect(egress.allowedHosts).toEqual(['api.openai.com']); // the guard's own default; the download hosts are not in it

    const started = await controller.localSearchDownload(principal, { consent: true });
    expect(started).toMatchObject({ enabled: true, active: false, state: 'downloading' });
    expect(started.consentedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    // Hugging Face's hosts were allowed before the download began.
    expect(hosts.at(-1)).toEqual(['api.openai.com', ...LOCAL_EMBEDDING_DOWNLOAD_HOSTS]);
    expect(egress.allowedHosts).toEqual(expect.arrayContaining([...LOCAL_EMBEDDING_DOWNLOAD_HOSTS]));
    await tick();
    expect(await controller.localSearchStatus()).toMatchObject({ state: 'downloading', progress: 0.25 });
    // Not ready yet: search is still the primary provider's.
    expect((await ai.port.capabilities({ userId: LOCAL_USER_ID, orgId: null, feature: 'search.embed' })).embeddings?.model).not.toBe(KVOX_LOCAL_EMBEDDING.model);

    fake.finish();
    await ai.localEmbeddings.settled();
    await tick();
    // The hosts left the allowlist the moment the download ended, and indexing was requested.
    await vi.waitFor(() => expect(hosts.at(-1)).toEqual(['api.openai.com']));
    expect(egress.allowedHosts).toEqual(['api.openai.com']);
    await vi.waitFor(() => expect(activated).toHaveLength(1));
    expect(await controller.localSearchStatus()).toMatchObject({ enabled: true, active: true, state: 'ready', progress: 1 });

    // search.embed is on-device: the local model, 1536 wide, keyless; graph.embed is not.
    const search = await ai.port.capabilities({ userId: LOCAL_USER_ID, orgId: null, feature: 'search.embed' });
    expect(search).toMatchObject({ available: true, embeddings: { model: KVOX_LOCAL_EMBEDDING.model, dimensions: 1536, nativeDimensions: 384, minSimilarity: 0.45 } });
    const graph = await ai.port.capabilities({ userId: LOCAL_USER_ID, orgId: null, feature: 'graph.embed' });
    expect(graph.embeddings?.model).not.toBe(KVOX_LOCAL_EMBEDDING.model);

    const query = await ai.port.embed({ userId: LOCAL_USER_ID, orgId: null, feature: 'search.embed' }, { inputs: ['budget'], purpose: 'query' });
    expect(query).toMatchObject({ model: KVOX_LOCAL_EMBEDDING.model, dimensions: 1536 });
    expect(query.vectors[0]).toHaveLength(1536);
    expect(embedded.at(-1)).toEqual({ modelPath: fake.modelPath, texts: [`${KVOX_LOCAL_EMBEDDING.queryPrefix}budget`] });

    // Off: back to the primary provider, the model stays installed.
    expect(await controller.localSearchUpdate(principal, { enabled: false })).toMatchObject({ enabled: false, active: false, state: 'ready' });
    expect((await ai.port.capabilities({ userId: LOCAL_USER_ID, orgId: null, feature: 'search.embed' })).embeddings?.model).not.toBe(KVOX_LOCAL_EMBEDDING.model);
    // On again: allowed, since it is installed and consented.
    expect(await controller.localSearchUpdate(principal, { enabled: true })).toMatchObject({ enabled: true, active: true });
    expect(activated.length).toBeGreaterThanOrEqual(2);

    // Remove: the model goes, the feature goes off, the consent is kept.
    const removed = await controller.localSearchRemove(principal);
    expect(removed).toMatchObject({ enabled: false, active: false, state: 'missing', progress: null });
    expect(removed.consentedAt).not.toBeNull();
    expect(fake.state.removed).toBe(1);
  });

  it('cancelling switches the feature back off and drops the download hosts; a failure does the same', async () => {
    const { ai, controller, fake, hosts } = setup();
    await ai.start();
    await controller.localSearchDownload(principal, { consent: true });
    await tick();
    const cancelled = await controller.localSearchDownloadCancel(principal);
    expect(cancelled).toMatchObject({ enabled: false, state: 'missing' });
    await ai.localEmbeddings.settled();
    await vi.waitFor(() => expect(hosts.at(-1)).toEqual(['api.openai.com']));

    await controller.localSearchDownload(principal, { consent: true });
    await tick();
    fake.fail('Hugging Face answered 503');
    await ai.localEmbeddings.settled();
    // The settle handler writes the setting asynchronously.
    await vi.waitFor(async () => expect(await controller.localSearchStatus()).toMatchObject({ enabled: false, state: 'error', error: 'Hugging Face answered 503' }));
    await vi.waitFor(() => expect(hosts.at(-1)).toEqual(['api.openai.com']));
  });

  it('serves on-device at start-up when it was on and the model is installed, and asks for indexing', async () => {
    await settings.patchSystem(DESKTOP_AI_NAMESPACE, { localSearch: { enabled: true, consentedAt: '2026-10-21T00:00:00.000Z' } }, { actorUserId: LOCAL_USER_ID });
    const { ai, activated } = setup({ installed: true });
    await ai.start();
    expect(activated).toHaveLength(1);
    expect(await ai.localSearchActive()).toBe(true);
    // Installed but switched off: not active, nothing requested.
    await settings.patchSystem(DESKTOP_AI_NAMESPACE, { localSearch: { enabled: false } }, { actorUserId: LOCAL_USER_ID });
    const second = setup({ installed: true });
    await second.ai.start();
    expect(second.activated).toHaveLength(0);
    expect(await second.ai.localSearchActive()).toBe(false);
  });

  it('answers 409 local_search_unavailable in a build without the embedder', async () => {
    const ai = new DesktopAi({ settings, secrets, adapters: providers.adapters, onAllowedHosts: () => undefined });
    created.push(ai);
    const controller = new DesktopAiController(ai.port, ai, new EgressGuard({ logError: () => undefined }));
    await expect(controller.localSearchDownload(principal, { consent: true })).rejects.toMatchObject({ status: 409, response: { code: 'local_search_unavailable' } });
    expect(await ai.localSearchActive()).toBe(false);
  });
});

// ---- The main process: broker, host, bridge --------------------------------------

/** A stand-in for the utility process. */
class FakeChild extends EventEmitter implements EmbedderChild {
  readonly sent: EmbedderRequest[] = [];
  killed = false;
  postMessage(message: EmbedderRequest): void {
    this.sent.push(message);
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
  answer(response: EmbedderResponse): void {
    this.emit('message', response);
  }
  die(code: number | null = 1): void {
    this.emit('exit', code);
  }
}

describe('EmbedderBroker', () => {
  let children: FakeChild[];
  let broker: EmbedderBroker;

  beforeEach(() => {
    vi.useFakeTimers();
    children = [];
    broker = new EmbedderBroker({
      fork: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      idleMs: 1000,
      requestTimeoutMs: 5000,
    });
  });
  afterEach(() => vi.useRealTimers());

  it('forks lazily on the first request, relays the answer and keeps the process', async () => {
    expect(children).toHaveLength(0);
    const first = broker.request('/m', ['a']);
    expect(children).toHaveLength(1);
    expect(children[0]!.sent).toEqual([{ id: 1, modelPath: '/m', texts: ['a'] }]);
    children[0]!.answer({ id: 1, vectors: [[1, 2]] });
    await expect(first).resolves.toEqual([[1, 2]]);
    const second = broker.request('/m', ['b']);
    expect(children).toHaveLength(1);
    children[0]!.answer({ id: 2, vectors: [[3]] });
    await expect(second).resolves.toEqual([[3]]);
  });

  it('relays the embedder\'s error to the one request it belongs to', async () => {
    const a = broker.request('/m', ['a']);
    const b = broker.request('/m', ['b']);
    children[0]!.answer({ id: 2, error: 'out of memory' });
    children[0]!.answer({ id: 1, vectors: [[1]] });
    await expect(b).rejects.toThrow('out of memory');
    await expect(a).resolves.toEqual([[1]]);
  });

  it('kills the idle process, then forks a new one on the next request', async () => {
    const first = broker.request('/m', ['a']);
    children[0]!.answer({ id: 1, vectors: [[1]] });
    await first;
    await vi.advanceTimersByTimeAsync(999);
    expect(children[0]!.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(children[0]!.killed).toBe(true);
    expect(broker.running).toBe(false);
    const next = broker.request('/m', ['b']);
    expect(children).toHaveLength(2);
    children[1]!.answer({ id: 2, vectors: [[2]] });
    await expect(next).resolves.toEqual([[2]]);
  });

  it('does not go idle while a request is in flight', async () => {
    const pending = broker.request('/m', ['a']);
    await vi.advanceTimersByTimeAsync(4000);
    expect(children[0]!.killed).toBe(false);
    children[0]!.answer({ id: 1, vectors: [[1]] });
    await pending;
  });

  it('fails everything in flight when the process dies, and restarts on the next request', async () => {
    const a = broker.request('/m', ['a']);
    const b = broker.request('/m', ['b']);
    children[0]!.die(137);
    await expect(a).rejects.toThrow('stopped unexpectedly (code 137)');
    await expect(b).rejects.toThrow('stopped unexpectedly');
    expect(broker.pending).toBe(0);
    expect(broker.running).toBe(false);
    const again = broker.request('/m', ['c']);
    expect(children).toHaveLength(2);
    children[1]!.answer({ id: 3, vectors: [[9]] });
    await expect(again).resolves.toEqual([[9]]);
  });

  it('kills a wedged process after the request timeout', async () => {
    const wedged = broker.request('/m', ['a']);
    const caught = wedged.then(() => new Error('answered'), (error: Error) => error);
    await vi.advanceTimersByTimeAsync(5001);
    expect((await caught).message).toMatch(/did not answer in time/);
    expect(children[0]!.killed).toBe(true);
    // A late exit event of the killed process does not disturb the next one.
    const next = broker.request('/m', ['b']);
    children[0]!.die(null);
    children[1]!.answer({ id: 2, vectors: [[1]] });
    await expect(next).resolves.toEqual([[1]]);
  });

  it('shuts down on quit: kills the process, fails what is in flight, refuses more, and can reopen', async () => {
    const pending = broker.request('/m', ['a']);
    const caught = pending.then(() => new Error('answered'), (error: Error) => error);
    broker.shutdown();
    expect((await caught).message).toMatch(/shut down/);
    expect(children[0]!.killed).toBe(true);
    await expect(broker.request('/m', ['b'])).rejects.toThrow('shut down');
    broker.reopen();
    const ok = broker.request('/m', ['c']);
    children[1]!.answer({ id: 2, vectors: [[1]] });
    await expect(ok).resolves.toEqual([[1]]);
  });
});

describe('the embedder process\'s host', () => {
  function host(models: Record<string, () => { embed(texts: string[]): Promise<number[][]> }>) {
    const sent: EmbedderResponse[] = [];
    const loads: string[] = [];
    const disposed: string[] = [];
    const created = createEmbedderHost({
      load: async (path) => {
        loads.push(path);
        const model = models[path]?.();
        if (!model) throw new Error(`no model at ${path}`);
        return { embed: model.embed, dispose: async () => void disposed.push(path) };
      },
      send: (response) => void sent.push(response),
    });
    return { ...created, sent, loads, disposed };
  }

  it('loads once, answers each request exactly once and in order, one batch at a time', async () => {
    let concurrent = 0;
    let peak = 0;
    const h = host({
      '/m': () => ({
        embed: async (texts) => {
          concurrent += 1;
          peak = Math.max(peak, concurrent);
          await tick();
          concurrent -= 1;
          return texts.map((text) => [text.length]);
        },
      }),
    });
    await Promise.all([h.handle({ id: 1, modelPath: '/m', texts: ['a'] }), h.handle({ id: 2, modelPath: '/m', texts: ['bb', 'c'] }), h.handle({ id: 3, modelPath: '/m', texts: [''] })]);
    expect(h.sent).toEqual([
      { id: 1, vectors: [[1]] },
      { id: 2, vectors: [[2], [1]] },
      { id: 3, vectors: [[0]] },
    ]);
    expect(h.loads).toEqual(['/m']);
    expect(peak).toBe(1);
  });

  it('answers a failure with an error, retries the load next time, and reloads for another directory', async () => {
    let attempts = 0;
    const h = host({
      '/flaky': () => {
        attempts += 1;
        if (attempts === 1) throw new Error('the file is damaged');
        return { embed: async (texts) => texts.map(() => [1]) };
      },
      '/other': () => ({ embed: async (texts) => texts.map(() => [2]) }),
    });
    await h.handle({ id: 1, modelPath: '/missing', texts: ['a'] });
    await h.handle({ id: 2, modelPath: '/flaky', texts: ['a'] });
    await h.handle({ id: 3, modelPath: '/flaky', texts: ['a'] });
    await h.handle({ id: 4, modelPath: '/other', texts: ['a'] });
    await h.handle({ id: 5, modelPath: '', texts: ['a'] });
    expect(h.sent).toEqual([
      { id: 1, error: 'no model at /missing' },
      { id: 2, error: 'the file is damaged' },
      { id: 3, vectors: [[1]] },
      { id: 4, vectors: [[2]] },
      { id: 5, error: 'A malformed embed request' },
    ]);
    expect(h.disposed).toEqual(['/flaky']);
  });
});

describe('the server\'s side of an embed request', () => {
  it('sends the request to the main process and resolves or rejects with its answer', async () => {
    const sent: FromServer[] = [];
    const bridge = new MainBridge((message) => void sent.push(message));
    const ok = bridge.embed('/m', ['a', 'b']);
    const bad = bridge.embed('/m', ['c']);
    expect(sent).toEqual([
      { type: 'embed', id: 1, modelPath: '/m', texts: ['a', 'b'] },
      { type: 'embed', id: 2, modelPath: '/m', texts: ['c'] },
    ]);
    expect(bridge.handle({ type: 'embed-result', id: 2, ok: false, error: 'boom' })).toBe(true);
    expect(bridge.handle({ type: 'embed-result', id: 1, ok: true, vectors: [[1], [2]] })).toBe(true);
    await expect(ok).resolves.toEqual([[1], [2]]);
    await expect(bad).rejects.toThrow('boom');
    // A late answer for a request that is gone is absorbed.
    expect(bridge.handle({ type: 'embed-result', id: 1, ok: true, vectors: [] })).toBe(true);
  });
});

describe('the unpacked WASM glue', () => {
  it('maps a path inside app.asar to app.asar.unpacked, and leaves any other alone', () => {
    const inside = join('/opt/KVox/resources/app.asar', 'node_modules', 'onnxruntime-web', 'dist', 'ort-wasm-simd-threaded.mjs');
    expect(unpackedRuntimeFile(inside)).toBe(join('/opt/KVox/resources/app.asar.unpacked', 'node_modules', 'onnxruntime-web', 'dist', 'ort-wasm-simd-threaded.mjs'));
    expect(unpackedRuntimeFile(join('/work/kvox-desktop/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs'))).toBeNull();
    expect(unpackedRuntimeFile('/opt/KVox/resources/app.asar.unpacked/node_modules/x.mjs')).toBeNull();
  });
});
