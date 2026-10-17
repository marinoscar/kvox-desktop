import { z } from 'zod';

import type { KvoxSettingsNamespaceDef } from '@marinoscar/kvox-api/ports';

import { isLoopback } from '../egress-guard.js';

// =============================================================================
// The AI provider settings of KVox Desktop (marinoscar/kvox#584)
// =============================================================================
//
// Which provider runs the user's AI calls, which model, and where an
// OpenAI-compatible server lives. NON-SECRET only: a key never enters this
// namespace (it lives in KVOX_SECRETS, purpose `ai`, named after the provider).
// The settings are the system namespace `desktopAi` of KVOX_SETTINGS, so they
// sit in the database and travel in a backup (the keys do not).
//
// THE PROVIDER SLOTS:
//   openai             api.openai.com; the default.
//   openai-compatible  a server the user names (Ollama, vLLM, LM Studio, a
//                      gateway): base URL, model, wire style, keyless or not.
//   copilot            DECIDED, NOT BUILT (marinoscar/kvox#581: "go, without
//                      Ask"). The slot exists, stays disabled and cannot be
//                      selected until its adapter ships; when it does, its
//                      models report toolCalling=false, so Ask stays off on it.
//
// THE EGRESS RULE: the server may reach exactly the active provider's host
// ({@link allowedHostsFor}), besides loopback, which is always allowed.
// =============================================================================

/** The KVOX_SETTINGS system namespace. */
export const DESKTOP_AI_NAMESPACE = 'desktopAi';

/** The KVOX_SECRETS purpose the provider keys are stored under (the name is the provider id). */
export const AI_KEY_PURPOSE = 'ai';

/** The provider slots, in the settings page's order. */
export const DESKTOP_AI_PROVIDER_IDS = ['openai', 'openai-compatible', 'copilot'] as const;
export type DesktopAiProviderId = (typeof DESKTOP_AI_PROVIDER_IDS)[number];

/** The slots that have an adapter today and may be selected. */
export const SELECTABLE_AI_PROVIDER_IDS = ['openai', 'openai-compatible'] as const;
export type SelectableAiProviderId = (typeof SELECTABLE_AI_PROVIDER_IDS)[number];

/** What the settings page and the task-model source know about a slot. */
export interface DesktopAiProviderSlot {
  id: DesktopAiProviderId;
  label: string;
  /** False while the adapter does not exist: the slot is shown disabled. */
  implemented: boolean;
  /** Whether the slot's models may be offered tool calling (Ask). */
  toolCalling: boolean;
  /** A one-line note the settings page shows under the slot. */
  note: string;
}

export const DESKTOP_AI_PROVIDERS: readonly DesktopAiProviderSlot[] = [
  { id: 'openai', label: 'OpenAI', implemented: true, toolCalling: true, note: 'Uses api.openai.com with your OpenAI API key.' },
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible server',
    implemented: true,
    toolCalling: true,
    note: 'A server that speaks the OpenAI API (Ollama, vLLM, LM Studio, a gateway). Only its host is reachable.',
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    implemented: false,
    toolCalling: false,
    note: 'Coming later (opt-in). Note generation only: Ask is not available with Copilot.',
  },
];

/** The host of the OpenAI provider (the platform adapter's default base URL). */
export const OPENAI_HOST = 'api.openai.com';

/** The model the OpenAI slot starts with. */
export const DEFAULT_OPENAI_MODEL = 'gpt-5.4-mini';

const modelId = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[\w.:/@+-]+$/, 'A model id has no spaces');

/** An http(s) URL without credentials, a query or a fragment. */
const baseUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === '' && url.search === '' && url.hash === '';
    } catch {
      return false;
    }
  }, 'The base URL must be an http(s) URL with no credentials, query or fragment')
  .transform((value) => value.replace(/\/+$/, ''));

export const desktopAiSettingsSchema = z.object({
  /** The active provider, or `null` for AI off. */
  provider: z.enum(SELECTABLE_AI_PROVIDER_IDS).nullable(),
  openai: z.object({ model: modelId }),
  openaiCompatible: z.object({
    baseUrl: baseUrl.nullable(),
    model: modelId.nullable(),
    apiStyle: z.enum(['chat_completions', 'responses']),
    /** False for a server that takes no key (a local Ollama). */
    requiresKey: z.boolean(),
  }),
  /** The disabled Copilot slot: it cannot be switched on until its adapter exists (marinoscar/kvox#581). */
  copilot: z.object({ enabled: z.literal(false) }),
});

export type DesktopAiSettings = z.infer<typeof desktopAiSettingsSchema>;

export const DEFAULT_DESKTOP_AI_SETTINGS: DesktopAiSettings = {
  provider: 'openai',
  openai: { model: DEFAULT_OPENAI_MODEL },
  openaiCompatible: { baseUrl: null, model: null, apiStyle: 'chat_completions', requiresKey: true },
  copilot: { enabled: false },
};

/** The namespace as KVOX_SETTINGS registers it. */
export const DESKTOP_AI_SETTINGS_NAMESPACE: KvoxSettingsNamespaceDef = {
  scope: 'system',
  name: DESKTOP_AI_NAMESPACE,
  schema: desktopAiSettingsSchema,
  defaults: DEFAULT_DESKTOP_AI_SETTINGS,
};

/** The active provider's model, or `null` when it has none configured. */
export function activeModel(settings: DesktopAiSettings): string | null {
  if (settings.provider === 'openai') return settings.openai.model;
  if (settings.provider === 'openai-compatible') return settings.openaiCompatible.baseUrl ? settings.openaiCompatible.model : null;
  return null;
}

/** Whether a provider's calls need a stored key under these settings. */
export function needsKey(provider: SelectableAiProviderId, settings: DesktopAiSettings): boolean {
  return provider === 'openai' || settings.openaiCompatible.requiresKey;
}

/**
 * The hosts the server may reach under these settings: the active provider's
 * host, nothing else. A server on this device needs no entry (loopback is always
 * allowed), so it answers an empty list.
 */
export function allowedHostsFor(settings: DesktopAiSettings): string[] {
  if (settings.provider === 'openai') return [OPENAI_HOST];
  if (settings.provider === 'openai-compatible' && settings.openaiCompatible.baseUrl) {
    const host = new URL(settings.openaiCompatible.baseUrl).hostname;
    return isLoopback(host) ? [] : [host];
  }
  return [];
}
