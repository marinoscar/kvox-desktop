import { randomUUID } from 'node:crypto';

import { BadRequestException } from '@nestjs/common';

import { createDirectRuntime, createKvoxAi, type KvoxAiModelState, type KvoxAiProviderKey, type KvoxTaskModelSource } from '@marinoscar/kvox-ai';
import type { KvoxAiPort, KvoxSecretStatus, KvoxSecretsPort, KvoxSettingsPort } from '@marinoscar/kvox-api/ports';
import { AI_KEYLESS_API_KEY, type AiCallContext, type AiProviderAdapter } from '@marinoscar/platform-ai-providers';
import { createOpenAiAdapter, createOpenAiCompatibleAdapter } from '@marinoscar/platform-ai-providers/openai';

import { isLoopback } from '../egress-guard.js';
import {
  AI_KEY_PURPOSE,
  DESKTOP_AI_NAMESPACE,
  DESKTOP_AI_PROVIDERS,
  SELECTABLE_AI_PROVIDER_IDS,
  activeModel,
  OPENAI_HOST,
  allowedHostsFor,
  needsKey,
  type DesktopAiSettings,
  type SelectableAiProviderId,
} from './desktop-ai-settings.js';

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
//                built with its plain factories: no Nest, no platform runtime.
//   keys         per call, from KVOX_SECRETS (purpose `ai`, named after the
//                provider): the OS keychain through `safeStorage`. Nothing is
//                cached; the runtime drops the key when the call settles.
//   taskModels   the `desktopAi` settings: the active provider and its one
//                model, plus the slices' `ai` token ceilings.
//
// THE EGRESS RULE: every settings change re-derives the allowlist
// (`allowedHostsFor`) and hands it to the server's egress guard, so only the
// active provider's host is reachable.
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
   * The egress guard's check: a key test asks it before any request, so a
   * refused host is answered with a readable result instead of a socket error.
   * Absent: no pre-check (the guard still blocks the connection itself).
   */
  checkEgress?: (host: string) => Error | null;
}

/** Whether `id` names a provider slot with an adapter. */
export function isSelectableProvider(id: string): id is SelectableAiProviderId {
  return (SELECTABLE_AI_PROVIDER_IDS as readonly string[]).includes(id);
}

/** The KVOX_AI binding, the provider settings and the provider keys. */
export class DesktopAi {
  /** KVOX_AI. */
  readonly port: KvoxAiPort;
  readonly taskModels: KvoxTaskModelSource;

  constructor(private readonly options: DesktopAiOptions) {
    options.secrets.registerPurpose(AI_KEY_PURPOSE, 'AI provider API keys');
    this.taskModels = { load: () => this.modelState() };
    const runtime = createDirectRuntime({ adapters: options.adapters, keys: (provider) => this.keyFor(provider) });
    this.port = createKvoxAi({
      runtime,
      taskModels: this.taskModels,
      ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    });
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
    return saved;
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
    const slot = DESKTOP_AI_PROVIDERS.find((candidate) => candidate.id === provider);
    throw new BadRequestException({
      message: slot ? `${slot.label} is not available yet.` : 'Unknown AI provider.',
      code: 'ai_provider_unavailable',
    });
  }

  /** `createDirectRuntime`'s key source: asked on every call, nothing kept. */
  private async keyFor(provider: string): Promise<KvoxAiProviderKey | null> {
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

  /** The task-model state: the active provider and its one model. */
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
}
