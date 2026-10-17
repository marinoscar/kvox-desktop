import { BadRequestException, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { createDirectRuntime, createKvoxAi, type KvoxAiModelState, type KvoxAiProviderKey, type KvoxTaskModelSource } from '@marinoscar/kvox-ai';
import type { KvoxAiPort, KvoxSecretStatus, KvoxSecretsPort, KvoxSettingsPort } from '@marinoscar/kvox-api/ports';
import {
  AI_KEYLESS_API_KEY,
  AiCoreModule,
  AiProviderRegistry,
  OpenAiCompatibleProviderModule,
  OpenAiProviderModule,
  type AiProviderAdapter,
} from '@marinoscar/platform-api/ai';

import {
  AI_KEY_PURPOSE,
  DESKTOP_AI_NAMESPACE,
  DESKTOP_AI_PROVIDERS,
  SELECTABLE_AI_PROVIDER_IDS,
  activeModel,
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
//   adapters     the platform's OpenAI and OpenAI-compatible
//                `AiProviderAdapter`s (`@marinoscar/platform-api/ai`, an interim
//                peer until the lean adapter package of marinoscar/kvox#578),
//                taken from their own Nest modules' provider registry.
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
}

/** What a key status read answers (never the key). */
export type DesktopAiKeyStatus = KvoxSecretStatus;

/** An API key as `setKey` accepts it: visible ASCII, no spaces. */
const API_KEY_PATTERN = /^[\x21-\x7e]{8,4096}$/;

@Module({ imports: [AiCoreModule, OpenAiProviderModule, OpenAiCompatibleProviderModule] })
class DesktopAiProvidersModule {}

/** The provider adapters, in a Nest context of their own (their modules self-register). */
export interface DesktopAiAdapters {
  adapters: Readonly<Record<string, AiProviderAdapter>>;
  close(): Promise<void>;
}

/** Boots the platform's OpenAI and OpenAI-compatible provider modules and takes their adapters. */
export async function loadProviderAdapters(): Promise<DesktopAiAdapters> {
  const context = await NestFactory.createApplicationContext(DesktopAiProvidersModule, { logger: ['error', 'warn'] });
  const registry = context.get(AiProviderRegistry);
  const adapters: Record<string, AiProviderAdapter> = {};
  for (const id of SELECTABLE_AI_PROVIDER_IDS) adapters[id] = registry.require(id);
  return { adapters, close: () => context.close() };
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
        // The graph is not mounted on Desktop yet (D5).
        graphEnabled: false,
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
