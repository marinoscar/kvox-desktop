import { randomUUID } from 'node:crypto';

import { BadRequestException, ConflictException } from '@nestjs/common';

import {
  KVOX_LOCAL_EMBEDDING,
  KVOX_TASK_IDS,
  createDirectRuntime,
  createKvoxAi,
  routeKvoxTasks,
  type KvoxAiModelState,
  type KvoxAiProviderKey,
  type KvoxTaskId,
  type KvoxTaskModelSource,
  type KvoxTaskUnavailable,
  type ProviderChoice,
} from '@marinoscar/kvox-ai';
import { LOCAL_EMBEDDING_DOWNLOAD_HOSTS, createLocalEmbeddingRuntime } from '@marinoscar/kvox-ai/local-embeddings';
import type { KvoxAiPort, KvoxSecretStatus, KvoxSecretsPort, KvoxSettingsPort } from '@marinoscar/kvox-api/ports';
import { AI_KEYLESS_API_KEY, AiError, type AiCallContext, type AiProviderAdapter } from '@marinoscar/platform-ai-providers';
import { createOpenAiAdapter, createOpenAiCompatibleAdapter } from '@marinoscar/platform-ai-providers/openai';

import { isLoopback } from '../egress-guard.js';
import { COPILOT_CONSENT_VERSION, type CopilotSettings, type CopilotSignInChallenge, type CopilotStatus } from '@marinoscar/kvox-contract/copilot';
import type { CopilotHost } from './copilot-host.js';
import { CopilotConflictError, CopilotService } from './copilot-service.js';
import {
  AI_KEY_PURPOSE,
  DESKTOP_AI_NAMESPACE,
  DESKTOP_AI_PROVIDERS,
  SELECTABLE_AI_PROVIDER_IDS,
  activeModel,
  OPENAI_HOST,
  allowedHostsFor,
  copilotActive,
  needsKey,
  type DesktopAiSettings,
  type SelectableAiProviderId,
} from './desktop-ai-settings.js';
import { LOCAL_EMBEDDING_SIZE_BYTES, LocalEmbeddingsService, type LocalEmbeddingsDownloader, type LocalEmbeddingsState } from './local-embeddings.js';
import { createRoutedKvoxAi, type RoutedProvider } from './routed-kvox-ai.js';

/** The Copilot provider id (`COPILOT_PROVIDER_ID` of `@marinoscar/kvox-ai/copilot`, which is not loaded until Copilot is on). */
const COPILOT_ID = 'copilot';

// =============================================================================
// KVOX_AI for KVox Desktop: createKvoxAi over createDirectRuntime (marinoscar/kvox#584)
// =============================================================================
//
// ADR-0005: Desktop does not implement the model port. It binds the package's
// `createKvoxAi` (`@marinoscar/kvox-ai`) over `createDirectRuntime`, and
// supplies only the three things a host owns:
//
//   adapters     the OpenAI and OpenAI-compatible `AiProviderAdapter`s of the
//                lean `@marinoscar/platform-ai-providers` (marinoscar/kvox#578),
//                built with its plain factories: no Nest, no platform runtime;
//                and, only while the user has switched Copilot on, the GitHub
//                Copilot adapter of `@marinoscar/kvox-ai/copilot` (CopilotService).
//   keys         per call, from KVOX_SECRETS (purpose `ai`, named after the
//                provider): the OS keychain through `safeStorage`. Nothing is
//                cached; the runtime drops the key when the call settles.
//   taskModels   the `desktopAi` settings: the active provider and its one
//                model, plus the slices' `ai` token ceilings.
//
// COPILOT IS AN ADD-ON (marinoscar/kvox-desktop#21). While it is on and consented,
// `routeKvoxTasks` gives each task to Copilot when Copilot can serve it (notes,
// titles, graph extraction, the name check) and else to the primary provider when
// that is usable (Ask, embeddings), else lists it as unavailable. Two
// `createKvoxAi` ports (one per provider) sit behind `createRoutedKvoxAi`.
//
// ON-DEVICE SEMANTIC SEARCH (marinoscar/kvox#660) is a third port, over the package's
// local embedding runtime, that serves ONLY `search.embed` (capabilities and embeddings)
// and only while the user switched it on AND the model is installed. The embedding
// itself runs in the main process's embedder utility process (`bridge.embed`); this
// file holds no model mechanics. `graph.embed` stays with the primary provider: the
// graph's similarity thresholds are tuned to OpenAI's vectors.
//
// THE EGRESS RULE: every settings change re-derives the allowlist
// (`allowedHostsFor`) and hands it to the server's egress guard, so only the
// active provider's host (and, while Copilot is on, the Copilot hosts) is
// reachable.
//
// ⚠ A KEY NEVER LEAVES KVOX_SECRETS except into one call's `AiCallContext`: it
// is not in a setting, a response, a log line or an error (`setKey` refuses a
// malformed key without echoing it).
// =============================================================================

/** The `ai` namespace fields the task-model source reads (declared in bootstrap.ts). */
interface SliceAiSettings {
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  /** The connected-knowledge switch (absent in a namespace declared without it: off). */
  graphEnabled?: boolean;
}

/** What a key status read answers (never the key). */
export type DesktopAiKeyStatus = KvoxSecretStatus;

/** An API key as `setKey` accepts it: visible ASCII, no spaces. */
const API_KEY_PATTERN = /^[\x21-\x7e]{8,4096}$/;

/** The longest a key test waits for the provider. */
const KEY_TEST_TIMEOUT_MS = 15_000;

/** One step of a key test (the platform's `AiProbeCheck` wire shape, which the shared key card renders). */
export interface DesktopAiKeyTestCheck {
  id: 'credentials' | 'list_models';
  label: string;
  status: 'passed' | 'failed' | 'skipped';
  code: string;
  detail: string;
  error: string | null;
}

/**
 * `POST /desktop/ai/keys/:provider/test`: the platform's `AiProbeResult` wire
 * shape. It never carries the key. A failed test is an ordinary answer (HTTP 200,
 * `success: false`), as on the web edition.
 */
export interface DesktopAiKeyTestResult {
  success: boolean;
  provider: string;
  usedStoredKey: boolean;
  modelCount: number | null;
  smokeModelId: null;
  checks: DesktopAiKeyTestCheck[];
  attemptedAt: string;
}

/** The provider adapters. */
export interface DesktopAiAdapters {
  adapters: Readonly<Record<string, AiProviderAdapter>>;
  close(): Promise<void>;
}

/** Builds the OpenAI and OpenAI-compatible adapters (one each; they hold no credential). */
export async function loadProviderAdapters(): Promise<DesktopAiAdapters> {
  const built: Record<string, AiProviderAdapter> = { openai: createOpenAiAdapter(), 'openai-compatible': createOpenAiCompatibleAdapter() };
  const adapters: Record<string, AiProviderAdapter> = {};
  for (const id of SELECTABLE_AI_PROVIDER_IDS) {
    const adapter = built[id];
    if (!adapter) throw new Error(`No adapter for the AI provider "${id}"`);
    adapters[id] = adapter;
  }
  return { adapters, close: async () => {} };
}

/** The on-device embedding model's host wiring (marinoscar/kvox#660). */
export interface DesktopLocalSearchOptions {
  /** `<userData>/models`. */
  directory: string;
  /** Embeds texts with the model installed at `modelPath`, in the embedder utility process (`MainBridge.embed`). */
  embed: (modelPath: string, texts: string[]) => Promise<number[][]>;
  /** A fake in the tests; the package's download otherwise. */
  downloader?: LocalEmbeddingsDownloader;
  /**
   * Local search is on and the model is installed (at start-up, when a download ends, when the user
   * switches it on): request indexing of the library. Must not throw.
   */
  onActive?: () => void;
}

/** `GET /desktop/ai/local-search`. */
export interface DesktopLocalSearchStatus {
  /** The user's switch. */
  enabled: boolean;
  /** Enabled AND the model is installed: `search.embed` is served on-device. */
  active: boolean;
  /** When the user consented to the one-time model download (ISO 8601). */
  consentedAt: string | null;
  state: LocalEmbeddingsState;
  /** 0..1 while downloading, 1 when ready, else `null`. */
  progress: number | null;
  /** Why the last download failed; `null` otherwise. */
  error: string | null;
  /** The model's id. */
  model: string;
  /** The download's size: the sum of the manifest's files. */
  sizeBytes: number;
  /** The hosts the one-time download reaches (allowed only while it runs). */
  hosts: string[];
}

/** Raised for the 409s of the local-search endpoints. */
export class LocalSearchConflictError extends Error {
  constructor(
    readonly code: 'consent_required' | 'model_not_ready' | 'local_search_unavailable',
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'LocalSearchConflictError';
  }
}

/** Options of {@link DesktopAi}. */
export interface DesktopAiOptions {
  settings: KvoxSettingsPort;
  secrets: KvoxSecretsPort;
  /** Provider id to adapter ({@link loadProviderAdapters}; a scripted adapter in the tests). */
  adapters: Readonly<Record<string, AiProviderAdapter>>;
  /** Receives the allowlist whenever the settings are read at start-up or changed. */
  onAllowedHosts: (hosts: string[]) => void;
  /** The request-timeout backstop; the package default (`DEFAULT_REQUEST_TIMEOUT_MS`) when absent. */
  requestTimeoutMs?: number;
  /**
   * How Copilot gets its runtime and transport (the seam of `copilot-host.ts`). Absent: Copilot
   * has no runtime in this process and reports it missing.
   */
  copilot?: CopilotHost;
  /** One line per Copilot event (never a prompt, an answer or a token). Default: nowhere. */
  log?: (line: string) => void;
  /**
   * The egress guard's check: a key test asks it before any request, so a
   * refused host is answered with a readable result instead of a socket error.
   * Absent: no pre-check (the guard still blocks the connection itself).
   */
  checkEgress?: (host: string) => Error | null;
  /** The on-device embedding model. Absent: local search is unavailable (its endpoints answer 409). */
  localSearch?: DesktopLocalSearchOptions;
}

/** A Copilot host with no runtime: the status says `missing`. */
function missingRuntimeHost(): CopilotHost {
  return {
    dataDirectory: '',
    canDownload: false,
    prepareRuntime: async () => {
      throw new AiError('AI_PROVIDER_UNAVAILABLE', 'No GitHub Copilot runtime is available.', { details: { check: 'runtime_missing' } });
    },
    createTransport: async () => {
      throw new Error('No GitHub Copilot runtime is available.');
    },
  };
}

/** Whether `id` names a provider slot with an adapter. */
export function isSelectableProvider(id: string): id is SelectableAiProviderId {
  return (SELECTABLE_AI_PROVIDER_IDS as readonly string[]).includes(id);
}

/** The KVOX_AI binding, the provider settings and the provider keys. */
export class DesktopAi {
  /** KVOX_AI. */
  readonly port: KvoxAiPort;
  /** The state of the provider that serves note generation (the notes screens' model list). */
  readonly taskModels: KvoxTaskModelSource;
  /** The Copilot add-on's lifecycle. */
  readonly copilot: CopilotService;
  /** The on-device embedding model's lifecycle. */
  readonly localEmbeddings: LocalEmbeddingsService;
  /** Who started the running model download (the settings writes on its end are theirs). */
  private localActor: string | null = null;
  /** The runtime's provider map: the primary adapters, plus Copilot while its adapter exists. */
  private readonly adapters: Record<string, AiProviderAdapter>;
  private readonly primaryState: KvoxTaskModelSource;
  private readonly copilotState: KvoxTaskModelSource;

  constructor(private readonly options: DesktopAiOptions) {
    options.secrets.registerPurpose(AI_KEY_PURPOSE, 'AI provider API keys');
    this.copilot = new CopilotService({
      host: options.copilot ?? missingRuntimeHost(),
      log: options.log ?? (() => undefined),
      // The download hosts leave the egress allowlist when the download ends, however it ends.
      onDownloadSettled: () => void this.read().then((settings) => this.options.onAllowedHosts(this.hostsFor(settings))),
    });
    // `createDirectRuntime` reads this record on every call. The Copilot entry is a getter on the
    // service, so the adapter appears when it is built (also after a later runtime download)
    // and disappears when Copilot is switched off.
    this.adapters = { ...options.adapters };
    Object.defineProperty(this.adapters, COPILOT_ID, {
      enumerable: false,
      configurable: true,
      get: () => this.copilot.providerAdapter ?? undefined,
    });
    this.localEmbeddings = new LocalEmbeddingsService({
      directory: options.localSearch?.directory ?? '',
      ...(options.localSearch?.downloader ? { downloader: options.localSearch.downloader } : {}),
      log: options.log ?? (() => undefined),
      onDownloadSettled: (state) => void this.localDownloadSettled(state).catch((error: unknown) => options.log?.(`local search: ${String(error)}`)),
    });
    this.primaryState = { load: () => this.modelState() };
    this.copilotState = { load: () => this.copilotModelState() };
    this.taskModels = { load: async (userId) => ((await this.serving('notes.generate')) === 'copilot' ? this.copilotState.load(userId) : this.primaryState.load(userId)) };
    const runtime = createDirectRuntime({ adapters: this.adapters, keys: (provider) => this.keyFor(provider) });
    const timeout = options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {};
    // The on-device embedding port: provider `local`, keyless, ready = installed AND switched on.
    const local = options.localSearch
      ? createKvoxAi({
          runtime: createLocalEmbeddingRuntime({ embed: (texts) => this.embedLocally(texts), ready: () => this.localSearchActive() }),
          taskModels: this.primaryState,
          embedding: KVOX_LOCAL_EMBEDDING,
          ...timeout,
        })
      : null;
    this.port = createRoutedKvoxAi({
      ...(local ? { local: { port: local, active: () => this.localSearchActive() } } : {}),
      primary: createKvoxAi({ runtime, taskModels: this.primaryState, ...timeout }),
      copilot: createKvoxAi({
        runtime,
        taskModels: this.copilotState,
        // Per model: no tool calling, and whether structured output is native or prompted.
        catalog: { lookup: (provider, model) => (provider === COPILOT_ID ? (this.copilot.providerAdapter?.kvox.catalog.lookup(provider, model) ?? null) : null) },
        ...timeout,
      }),
      serving: (task) => this.serving(task),
      copilotProviderId: COPILOT_ID,
    });
  }

  /** The egress allowlist under these settings (and the npm registry host while the runtime downloads). */
  private hostsFor(settings: DesktopAiSettings): string[] {
    return allowedHostsFor(settings, { runtimeDownload: this.copilot.downloading, modelDownload: this.localEmbeddings.downloading });
  }

  /** Brings Copilot up when the stored settings have it on, and learns whether the on-device model is installed (server start). */
  async start(): Promise<void> {
    await this.applyCopilot(await this.read());
    await this.localEmbeddings.init();
    if (await this.localSearchActive()) this.options.localSearch?.onActive?.();
  }

  /** Server shutdown: stops the Copilot runtime and any model download. */
  async close(): Promise<void> {
    await this.copilot.close();
    await this.localEmbeddings.close();
  }

  /** The provider settings (the defaults while nothing is saved). */
  async read(): Promise<DesktopAiSettings> {
    return (await this.options.settings.readSystem<DesktopAiSettings>(DESKTOP_AI_NAMESPACE)).value;
  }

  /** Reads the settings and hands their allowlist to the egress guard (start-up). */
  async applyEgress(): Promise<string[]> {
    const hosts = this.hostsFor(await this.read());
    this.options.onAllowedHosts(hosts);
    return hosts;
  }

  /** Applies a JSON Merge Patch (validated by the namespace schema), then the new allowlist. */
  async update(patch: unknown, actorUserId: string): Promise<DesktopAiSettings> {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new BadRequestException('The AI settings patch must be an object');
    await this.requireConsentFor(patch);
    await this.requireLocalSearchReadyFor(patch);
    let saved: DesktopAiSettings;
    try {
      saved = (await this.options.settings.patchSystem<DesktopAiSettings>(DESKTOP_AI_NAMESPACE, patch as Partial<DesktopAiSettings>, { actorUserId })).value;
    } catch (error) {
      if (error instanceof Error && error.name === 'ZodError') {
        const issues = (error as Error & { issues?: Array<{ path: PropertyKey[]; message: string }> }).issues ?? [];
        throw new BadRequestException({
          message: issues.map((issue) => `${issue.path.map(String).join('.') || 'settings'}: ${issue.message}`).join('; ') || 'Invalid AI settings',
          code: 'ai_settings_invalid',
        });
      }
      throw error;
    }
    this.options.onAllowedHosts(this.hostsFor(saved));
    await this.applyCopilot(saved);
    if (await this.localSearchActive()) this.options.localSearch?.onActive?.();
    return saved;
  }

  /** Updates the Copilot add-on's settings (the consent gate applies), then brings it up or down. */
  async updateCopilot(patch: Partial<CopilotSettings>, actorUserId: string): Promise<DesktopAiSettings> {
    return this.update({ copilot: patch }, actorUserId);
  }

  /**
   * Switching Copilot on needs the user's consent to the CURRENT text: refused before anything is
   * written, so no route (this one, `PATCH /settings`) can turn it on without it.
   */
  private async requireConsentFor(patch: object): Promise<void> {
    const copilot = (patch as { copilot?: unknown }).copilot;
    if (typeof copilot !== 'object' || copilot === null || Array.isArray(copilot)) return;
    const merged = { ...(await this.read()).copilot, ...(copilot as Partial<CopilotSettings>) };
    if (merged.enabled === true && (!merged.consentedAt || merged.consentVersion !== COPILOT_CONSENT_VERSION)) {
      throw new ConflictException({
        code: 'consent_required',
        message: 'Switching on GitHub Copilot needs your consent to the current terms first.',
        details: { consentVersion: COPILOT_CONSENT_VERSION },
      });
    }
  }

  // ---- On-device semantic search (marinoscar/kvox#660) ------------------------------

  /** Whether `search.embed` is served on-device now: switched on, consented, and the model is installed. */
  async localSearchActive(): Promise<boolean> {
    if (!this.options.localSearch || !this.localEmbeddings.ready) return false;
    const { enabled, consentedAt } = (await this.read()).localSearch;
    return enabled && consentedAt !== null;
  }

  private embedLocally(texts: string[]): Promise<number[][]> {
    const path = this.localEmbeddings.modelPath;
    if (!path || !this.options.localSearch) return Promise.reject(new Error('The on-device embedding model is not installed.'));
    return this.options.localSearch.embed(path, texts);
  }

  /** Switching local search on needs the user's consent AND the installed model: refused before anything is written, whichever route asks. */
  private async requireLocalSearchReadyFor(patch: object): Promise<void> {
    const localSearch = (patch as { localSearch?: unknown }).localSearch;
    if (typeof localSearch !== 'object' || localSearch === null || Array.isArray(localSearch)) return;
    if ((localSearch as { enabled?: unknown }).enabled !== true) return;
    const stored = (await this.read()).localSearch;
    const consentedAt = (localSearch as { consentedAt?: unknown }).consentedAt ?? stored.consentedAt;
    if (!this.options.localSearch) throw new LocalSearchConflictError('local_search_unavailable', 'On-device search is not available in this build.');
    if (typeof consentedAt !== 'string' || consentedAt === '') {
      throw new LocalSearchConflictError('consent_required', 'Download the on-device search model first: switching it on needs your consent to that one-time download.', this.localSearchFacts());
    }
    if (!this.localEmbeddings.ready) throw new LocalSearchConflictError('model_not_ready', 'The on-device search model is not installed yet.');
  }

  private localSearchFacts(): { sizeBytes: number; hosts: string[]; model: string } {
    return { sizeBytes: LOCAL_EMBEDDING_SIZE_BYTES, hosts: [...LOCAL_EMBEDDING_DOWNLOAD_HOSTS], model: KVOX_LOCAL_EMBEDDING.model };
  }

  async localSearchStatus(): Promise<DesktopLocalSearchStatus> {
    const { enabled, consentedAt } = (await this.read()).localSearch;
    const snapshot = this.localEmbeddings.snapshot();
    const facts = this.localSearchFacts();
    return {
      enabled,
      active: await this.localSearchActive(),
      consentedAt,
      state: snapshot.state,
      progress: snapshot.progress,
      error: snapshot.error,
      model: facts.model,
      sizeBytes: facts.sizeBytes,
      hosts: facts.hosts,
    };
  }

  /**
   * `POST /desktop/ai/local-search/download`: THE consent action. It records the consent, switches local
   * search on, allows Hugging Face's hosts for the download only, and starts it. Already installed:
   * it only switches the feature on.
   */
  async localSearchStartDownload(consent: unknown, actorUserId: string): Promise<DesktopLocalSearchStatus> {
    if (!this.options.localSearch) throw new LocalSearchConflictError('local_search_unavailable', 'On-device search is not available in this build.');
    if (consent !== true) {
      throw new LocalSearchConflictError('consent_required', 'Downloading the on-device search model needs your consent first.', this.localSearchFacts());
    }
    const saved = (
      await this.options.settings.patchSystem<DesktopAiSettings>(
        DESKTOP_AI_NAMESPACE,
        { localSearch: { enabled: true, consentedAt: new Date().toISOString() } } as Partial<DesktopAiSettings>,
        { actorUserId },
      )
    ).value;
    if (this.localEmbeddings.ready) {
      this.options.localSearch.onActive?.();
      return this.localSearchStatus();
    }
    this.localActor = actorUserId;
    // The hosts are allowed BEFORE the first byte is asked for, and dropped when the download ends.
    this.options.onAllowedHosts(allowedHostsFor(saved, { runtimeDownload: this.copilot.downloading, modelDownload: true }));
    this.localEmbeddings.startDownload();
    return this.localSearchStatus();
  }

  /** `DELETE /desktop/ai/local-search/download`: cancels a running download and switches local search off. */
  async localSearchCancelDownload(actorUserId: string): Promise<DesktopLocalSearchStatus> {
    this.localEmbeddings.cancelDownload();
    await this.switchLocalSearchOff(actorUserId);
    return this.localSearchStatus();
  }

  /** `PATCH /desktop/ai/local-search`: on (only with the model installed and consent given) or off. */
  async localSearchSetEnabled(enabled: boolean, actorUserId: string): Promise<DesktopLocalSearchStatus> {
    await this.update({ localSearch: { enabled } }, actorUserId);
    return this.localSearchStatus();
  }

  /** `DELETE /desktop/ai/local-search`: cancels any download, deletes the model and switches local search off. */
  async localSearchRemove(actorUserId: string): Promise<DesktopLocalSearchStatus> {
    // Off first: from this moment `search.embed` is no longer served on-device.
    await this.switchLocalSearchOff(actorUserId);
    await this.localEmbeddings.remove();
    return this.localSearchStatus();
  }

  private async switchLocalSearchOff(actorUserId: string): Promise<void> {
    if (!(await this.read()).localSearch.enabled) return;
    await this.options.settings.patchSystem<DesktopAiSettings>(DESKTOP_AI_NAMESPACE, { localSearch: { enabled: false } } as Partial<DesktopAiSettings>, { actorUserId });
  }

  /** A model download stopped running: drop the download hosts, and either index the library or switch the feature off. */
  private async localDownloadSettled(state: LocalEmbeddingsState): Promise<void> {
    const settings = await this.read();
    this.options.onAllowedHosts(this.hostsFor(settings));
    if (state === 'ready') {
      if (await this.localSearchActive()) this.options.localSearch?.onActive?.();
    } else if (this.localActor !== null) {
      // Cancelled or failed: the feature was switched on for this download, so it goes back off (the consent stays).
      await this.switchLocalSearchOff(this.localActor);
    }
  }

  /** Builds the Copilot adapter when Copilot is on and consented, and drops it otherwise. */
  private async applyCopilot(settings: DesktopAiSettings): Promise<void> {
    if (copilotActive(settings)) await this.copilot.activate();
    else await this.copilot.deactivate();
  }

  async keyStatus(provider: SelectableAiProviderId): Promise<DesktopAiKeyStatus> {
    return this.options.secrets.status(AI_KEY_PURPOSE, provider);
  }

  /** Stores a provider's key in KVOX_SECRETS. A malformed key is refused WITHOUT echoing it. */
  async setKey(provider: string, apiKey: unknown, actorUserId: string): Promise<DesktopAiKeyStatus> {
    const id = this.requireSelectable(provider);
    if (typeof apiKey !== 'string' || !API_KEY_PATTERN.test(apiKey)) {
      throw new BadRequestException({ message: 'An API key is 8 to 4096 visible characters with no spaces.', code: 'ai_key_invalid' });
    }
    await this.options.secrets.set(AI_KEY_PURPOSE, id, apiKey, actorUserId, { label: `${id} API key` });
    return this.keyStatus(id);
  }

  async deleteKey(provider: string, actorUserId: string): Promise<DesktopAiKeyStatus> {
    const id = this.requireSelectable(provider);
    await this.options.secrets.delete(AI_KEY_PURPOSE, id, actorUserId);
    return this.keyStatus(id);
  }

  /**
   * Tests a key against the provider, server-side, through the adapter's
   * `verifyKey` (and `listModels` for the count): the typed key when `apiKey` is
   * given, else the stored one. The key goes to the provider and nowhere else: not
   * into the result, an error or a log line. A rejected key, a refused host and an
   * unreachable provider are answers (`success: false`), not exceptions; only a
   * malformed typed key, an unknown slot or a slot with no adapter is a 400.
   */
  async testKey(provider: string, apiKey: unknown): Promise<DesktopAiKeyTestResult> {
    const id = this.requireSelectable(provider);
    const typed = apiKey === undefined || apiKey === null || apiKey === '' ? undefined : apiKey;
    if (typed !== undefined && (typeof typed !== 'string' || !API_KEY_PATTERN.test(typed))) {
      throw new BadRequestException({ message: 'An API key is 8 to 4096 visible characters with no spaces.', code: 'ai_key_invalid' });
    }
    const settings = await this.read();
    const usedStoredKey = typed === undefined;
    const outcome = (checks: DesktopAiKeyTestCheck[], modelCount: number | null = null): DesktopAiKeyTestResult => ({
      success: checks[0]?.status === 'passed',
      provider: id,
      usedStoredKey,
      modelCount,
      smokeModelId: null,
      checks,
      attemptedAt: new Date().toISOString(),
    });
    const failed = (code: string, detail: string): DesktopAiKeyTestResult =>
      outcome([{ id: 'credentials', label: 'Credentials', status: 'failed', code, detail, error: detail }]);

    const target = this.targetHost(id, settings);
    if (target === 'unconfigured') return failed('AI_PROVIDER_UNAVAILABLE', 'Enter the server base URL and save the AI settings first.');
    const refused = target === null ? null : this.options.checkEgress?.(target);
    if (refused) {
      return failed(
        'AI_PROVIDER_UNAVAILABLE',
        `KVox blocked the connection to ${target}: only the AI provider chosen in Settings can be reached. Select this provider and save, then test again.`,
      );
    }

    const secret = typed ?? (await this.keyFor(id))?.apiKey;
    if (!secret) return failed('AI_KEY_REQUIRED', 'No API key is saved for this provider.');
    const context = await this.callContext(id, secret, settings);
    const adapter = this.options.adapters[id];
    if (!context || !adapter) return failed('AI_PROVIDER_UNAVAILABLE', 'This provider is not configured.');
    const scrub = (text: string): string => text.split(secret).join('…');
    const withTimeout = (): AiCallContext => ({ ...context, signal: AbortSignal.timeout(KEY_TEST_TIMEOUT_MS) });

    let verification;
    try {
      verification = await adapter.verifyKey(withTimeout());
    } catch {
      return failed('AI_PROVIDER_UNAVAILABLE', 'The provider could not be reached.');
    }
    if (!verification.ok) return failed(verification.code ?? 'AI_PROVIDER_UNAVAILABLE', scrub(verification.detail ?? 'The provider did not accept the request.'));

    const credentials: DesktopAiKeyTestCheck = { id: 'credentials', label: 'Credentials', status: 'passed', code: 'OK', detail: '', error: null };
    try {
      const models = await adapter.listModels(withTimeout());
      return outcome(
        [credentials, { id: 'list_models', label: 'List models', status: 'passed', code: 'OK', detail: `${models.length} models`, error: null }],
        models.length,
      );
    } catch {
      return outcome([
        credentials,
        { id: 'list_models', label: 'List models', status: 'skipped', code: 'AI_PROVIDER_UNAVAILABLE', detail: 'The model list could not be read.', error: null },
      ]);
    }
  }

  /** The non-loopback host a call to `provider` reaches; `null` for this device; `'unconfigured'` with no server URL. */
  private targetHost(provider: SelectableAiProviderId, settings: DesktopAiSettings): string | null | 'unconfigured' {
    if (provider === 'openai') return OPENAI_HOST;
    const baseUrl = settings.openaiCompatible.baseUrl;
    if (!baseUrl) return 'unconfigured';
    const host = new URL(baseUrl).hostname;
    return isLoopback(host) ? null : host;
  }

  private requireSelectable(provider: string): SelectableAiProviderId {
    if (isSelectableProvider(provider)) return provider;
    if (provider === COPILOT_ID) {
      throw new BadRequestException({
        message: 'GitHub Copilot has no API key: it uses your GitHub sign-in.',
        code: 'ai_key_not_applicable',
      });
    }
    throw new BadRequestException({ message: 'Unknown AI provider.', code: 'ai_provider_unavailable' });
  }

  /** `createDirectRuntime`'s key source: asked on every call, nothing kept. */
  private async keyFor(provider: string): Promise<KvoxAiProviderKey | null> {
    // Copilot has no key: the runtime holds the user's sign-in. Signed out reads as "no key".
    if (provider === COPILOT_ID) return (await this.copilot.keyAvailable()) ? { apiKey: AI_KEYLESS_API_KEY } : null;
    if (!isSelectableProvider(provider)) return null;
    const settings = await this.read();
    if (provider === 'openai') {
      const apiKey = await this.options.secrets.get(AI_KEY_PURPOSE, provider);
      return apiKey ? { apiKey } : null;
    }
    const compatible = settings.openaiCompatible;
    if (!compatible.baseUrl) return null;
    const apiKey = needsKey(provider, settings) ? await this.options.secrets.get(AI_KEY_PURPOSE, provider) : AI_KEYLESS_API_KEY;
    if (!apiKey) return null;
    return {
      apiKey,
      baseUrl: compatible.baseUrl,
      providerSettings: { apiStyle: compatible.apiStyle, requiresKey: compatible.requiresKey },
    };
  }

  /** The adapter call context for a key test: the same endpoint and settings a real call uses, under `apiKey`. */
  private async callContext(provider: SelectableAiProviderId, apiKey: string, settings: DesktopAiSettings): Promise<AiCallContext | null> {
    if (provider === 'openai') return { apiKey, requestId: randomUUID() };
    const compatible = settings.openaiCompatible;
    if (!compatible.baseUrl) return null;
    return {
      apiKey,
      baseUrl: compatible.baseUrl,
      providerSettings: { apiStyle: compatible.apiStyle, requiresKey: compatible.requiresKey },
      requestId: randomUUID(),
    };
  }

  /** The primary provider's task-model state: the active provider and its one model. */
  private async modelState(): Promise<KvoxAiModelState> {
    const settings = await this.read();
    const limits = (await this.options.settings.readSystem<SliceAiSettings>('ai')).value;
    const model = activeModel(settings);
    const provider = model === null ? null : settings.provider;
    const slot = DESKTOP_AI_PROVIDERS.find((candidate) => candidate.id === provider);
    return {
      policy: {
        provider,
        defaultModel: model,
        // The connected-knowledge switch of the `ai` namespace (on by default on Desktop).
        graphEnabled: limits.graphEnabled === true,
        taskModels: {},
        // Chat Completions (the compatible servers' wire) takes no effort; OpenAI's own models do.
        reasoningEffort: provider === 'openai' ? 'medium' : 'none',
        enabled: provider !== null,
        maxInputTokens: limits.maxInputTokens,
        maxOutputTokens: limits.maxOutputTokens,
      },
      provider,
      models:
        model === null || !slot
          ? []
          : [{ id: model, label: model, structuredOutput: true, toolCalling: slot.toolCalling, contextWindow: null, maxOutputTokens: null }],
    };
  }

  // ---- Copilot: state, routing, status -------------------------------------------

  /** The Copilot add-on's task-model state: its models, none of them with tool calling. */
  private async copilotModelState(): Promise<KvoxAiModelState> {
    const settings = await this.read();
    const limits = (await this.options.settings.readSystem<SliceAiSettings>('ai')).value;
    const rows = copilotActive(settings) && this.copilot.ready ? await this.copilot.models() : [];
    const model = rows.length > 0 ? await this.copilot.pickModel(settings.copilot.model) : null;
    const provider = model === null ? null : COPILOT_ID;
    return {
      policy: {
        provider,
        defaultModel: model,
        graphEnabled: limits.graphEnabled === true,
        taskModels: {},
        reasoningEffort: 'none',
        enabled: provider !== null,
        maxInputTokens: limits.maxInputTokens,
        maxOutputTokens: limits.maxOutputTokens,
      },
      provider,
      models: rows.map((row) => ({
        id: row.id,
        label: row.label,
        structuredOutput: true,
        toolCalling: false,
        contextWindow: row.contextWindow,
        maxOutputTokens: row.maxOutputTokens,
        structuredOutputMode: row.structuredOutput,
      })),
    };
  }

  /** The primary provider as a routing choice, or `null` when it cannot serve a call now (off, no model, no key). */
  private async primaryChoice(settings: DesktopAiSettings): Promise<ProviderChoice | null> {
    const provider = settings.provider;
    const model = activeModel(settings);
    if (provider === null || model === null) return null;
    if (needsKey(provider, settings) && !(await this.keyStatus(provider)).configured) return null;
    return { provider, model, toolCalling: true, embeddings: true };
  }

  /** Which tasks go where while Copilot is on: Copilot first, the primary provider for the rest. */
  private async routing(settings: DesktopAiSettings): Promise<{ copilot: string; routes: ReturnType<typeof routeKvoxTasks> }> {
    const model = (await this.copilot.pickModel(settings.copilot.model)) ?? settings.copilot.model ?? '';
    const fallback = await this.primaryChoice(settings);
    const routes = routeKvoxTasks({ primary: { provider: COPILOT_ID, model, toolCalling: false, embeddings: false }, fallback });
    return { copilot: model, routes };
  }

  /** Which provider serves a task now. With Copilot off, always the primary provider. */
  private async serving(task: string): Promise<RoutedProvider> {
    const settings = await this.read();
    if (!copilotActive(settings)) return 'primary';
    // A task outside the routing table is not one Copilot's missing capabilities matter for.
    if (!(KVOX_TASK_IDS as readonly string[]).includes(task)) return 'copilot';
    const { routes } = await this.routing(settings);
    const routed = routes.taskModels[task as KvoxTaskId];
    if (routed) return routed.provider === COPILOT_ID ? 'copilot' : 'primary';
    // Nobody can serve it: ask the primary provider when it is set up (its refusal says why),
    // else Copilot (whose models say they cannot call tools).
    return settings.provider !== null && activeModel(settings) !== null ? 'primary' : 'copilot';
  }

  /**
   * The tasks Copilot's missing capabilities leave without a provider (empty while Copilot is off).
   * The embedding tasks are never reported: semantic search needs an OpenAI key with or without
   * Copilot (search stays full text otherwise), so listing them would say nothing about Copilot.
   * What is reported is what the user loses by switching Copilot on: Ask.
   */
  async unavailableTasks(): Promise<KvoxTaskUnavailable[]> {
    const settings = await this.read();
    if (!copilotActive(settings)) return [];
    return (await this.routing(settings)).routes.unavailable.filter((entry) => entry.reason !== 'needs_embeddings');
  }

  // ---- Copilot endpoints' operations ----------------------------------------------

  /** The Copilot status: sign-in, runtime, models and the tasks that have no provider. */
  async copilotStatus(): Promise<CopilotStatus> {
    const settings = await this.read();
    const active = copilotActive(settings);
    if (!active) {
      return { enabled: false, signedIn: false, login: null, runtime: this.copilot.runtimeStatus(), models: [], unavailableTasks: [] };
    }
    return { enabled: true, ...(await this.copilot.statusSnapshot()), unavailableTasks: await this.unavailableTasks() };
  }

  private async requireCopilotActive(): Promise<void> {
    if (!copilotActive(await this.read())) throw new CopilotConflictError('copilot_disabled', 'GitHub Copilot is off. Switch it on first.');
  }

  async copilotSignInStart(): Promise<CopilotSignInChallenge> {
    await this.requireCopilotActive();
    return this.copilot.signInStart();
  }

  async copilotSignInWait(signal?: AbortSignal): Promise<CopilotStatus> {
    await this.requireCopilotActive();
    await this.copilot.signInWait(signal);
    return this.copilotStatus();
  }

  async copilotSignOut(): Promise<CopilotStatus> {
    await this.requireCopilotActive();
    await this.copilot.signOut();
    return this.copilotStatus();
  }

  async copilotStartDownload(): Promise<CopilotStatus> {
    await this.requireCopilotActive();
    // The registry host is allowed BEFORE the first byte is asked for, and dropped when it ends.
    this.options.onAllowedHosts(allowedHostsFor(await this.read(), { runtimeDownload: true }));
    try {
      this.copilot.startDownload();
    } catch (error) {
      this.options.onAllowedHosts(this.hostsFor(await this.read()));
      throw error;
    }
    return this.copilotStatus();
  }

  /** "Remove Copilot data" (only with Copilot off): the private directory, and the downloaded runtime if asked. */
  async copilotRemoveData(includeRuntime: boolean): Promise<{ removed: string[]; keptRuntime: boolean }> {
    if (copilotActive(await this.read())) throw new CopilotConflictError('copilot_enabled', 'Switch GitHub Copilot off before removing its data.');
    return this.copilot.removeData({ includeRuntime });
  }

  async copilotCancelDownload(): Promise<CopilotStatus> {
    this.copilot.cancelDownload();
    return this.copilotStatus();
  }
}
