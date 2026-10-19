import { BadRequestException, ConflictException } from '@nestjs/common';

import {
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
import type { KvoxAiPort, KvoxSecretStatus, KvoxSecretsPort, KvoxSettingsPort } from '@marinoscar/kvox-api/ports';
import { AI_KEYLESS_API_KEY, type AiProviderAdapter } from '@marinoscar/platform-ai-providers';
import { createOpenAiAdapter, createOpenAiCompatibleAdapter } from '@marinoscar/platform-ai-providers/openai';

import { COPILOT_CONSENT_VERSION, type CopilotSettings, type CopilotSignInChallenge, type CopilotStatus } from './copilot-contract.js';
import type { CopilotHost } from './copilot-host.js';
import { CopilotConflictError, CopilotService } from './copilot-service.js';
import {
  AI_KEY_PURPOSE,
  DESKTOP_AI_NAMESPACE,
  DESKTOP_AI_PROVIDERS,
  SELECTABLE_AI_PROVIDER_IDS,
  activeModel,
  allowedHostsFor,
  copilotActive,
  needsKey,
  type DesktopAiSettings,
  type SelectableAiProviderId,
} from './desktop-ai-settings.js';
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
}

/** A Copilot host with no runtime: the status says `missing`. */
function missingRuntimeHost(): CopilotHost {
  return {
    dataDirectory: '',
    canDownload: false,
    prepareRuntime: async () => {
      throw Object.assign(new Error('No GitHub Copilot runtime is available.'), { details: { check: 'runtime_missing' } });
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
  /** The runtime's provider map: the primary adapters, plus Copilot while its adapter exists. */
  private readonly adapters: Record<string, AiProviderAdapter>;
  private readonly primaryState: KvoxTaskModelSource;
  private readonly copilotState: KvoxTaskModelSource;

  constructor(private readonly options: DesktopAiOptions) {
    options.secrets.registerPurpose(AI_KEY_PURPOSE, 'AI provider API keys');
    this.copilot = new CopilotService({ host: options.copilot ?? missingRuntimeHost(), log: options.log ?? (() => undefined) });
    // `createDirectRuntime` reads this record on every call, so Copilot's adapter can come and go.
    this.adapters = { ...options.adapters };
    this.primaryState = { load: () => this.modelState() };
    this.copilotState = { load: () => this.copilotModelState() };
    this.taskModels = { load: async (userId) => ((await this.serving('notes.generate')) === 'copilot' ? this.copilotState.load(userId) : this.primaryState.load(userId)) };
    const runtime = createDirectRuntime({ adapters: this.adapters, keys: (provider) => this.keyFor(provider) });
    const timeout = options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {};
    this.port = createRoutedKvoxAi({
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

  /** Brings Copilot up when the stored settings have it on (server start). */
  async start(): Promise<void> {
    await this.applyCopilot(await this.read());
  }

  /** Server shutdown: stops the Copilot runtime. */
  async close(): Promise<void> {
    await this.copilot.close();
  }

  /** The provider settings (the defaults while nothing is saved). */
  async read(): Promise<DesktopAiSettings> {
    return (await this.options.settings.readSystem<DesktopAiSettings>(DESKTOP_AI_NAMESPACE)).value;
  }

  /** Reads the settings and hands their allowlist to the egress guard (start-up). */
  async applyEgress(): Promise<string[]> {
    const hosts = allowedHostsFor(await this.read());
    this.options.onAllowedHosts(hosts);
    return hosts;
  }

  /** Applies a JSON Merge Patch (validated by the namespace schema), then the new allowlist. */
  async update(patch: unknown, actorUserId: string): Promise<DesktopAiSettings> {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new BadRequestException('The AI settings patch must be an object');
    await this.requireConsentFor(patch);
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
    this.options.onAllowedHosts(allowedHostsFor(saved));
    await this.applyCopilot(saved);
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

  /** Builds the Copilot adapter when Copilot is on and consented, and drops it otherwise. */
  private async applyCopilot(settings: DesktopAiSettings): Promise<void> {
    if (copilotActive(settings)) {
      await this.copilot.activate();
      this.syncCopilotAdapter();
    } else {
      this.syncCopilotAdapter(true);
      await this.copilot.deactivate();
    }
  }

  /** Mirrors the service's adapter into the runtime's provider map. */
  private syncCopilotAdapter(forceOff = false): void {
    const adapter = forceOff ? null : this.copilot.providerAdapter;
    if (adapter) this.adapters[COPILOT_ID] = adapter;
    else delete this.adapters[COPILOT_ID];
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
    this.copilot.startDownload();
    return this.copilotStatus();
  }

  async copilotCancelDownload(): Promise<CopilotStatus> {
    this.copilot.cancelDownload();
    return this.copilotStatus();
  }
}
