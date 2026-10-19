import { z } from 'zod';

import { COPILOT_EGRESS_HOSTS } from '@marinoscar/kvox-ai/copilot';
import { COPILOT_CONSENT_VERSION, COPILOT_DEFAULT_SETTINGS, CopilotSettingsSchema, type CopilotSettings } from '@marinoscar/kvox-contract/copilot';
import type { KvoxSettingsNamespaceDef } from '@marinoscar/kvox-api/ports';

import { isLoopback } from '../egress-guard.js';
import { COPILOT_RUNTIME_DOWNLOAD_HOSTS } from './copilot-sandbox.js';

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
//   copilot            GitHub Copilot (marinoscar/kvox#581, enabled by
//                      marinoscar/kvox-desktop#21). NOT a choice of `provider`: an
//                      opt-in ADD-ON, default off, switched on only after the
//                      user's consent. While it is on, the tasks it can serve
//                      (notes, titles, graph extraction, the name check) go to
//                      Copilot, and the rest (Ask, which needs tool calling, and
//                      the embeddings) go to the primary provider when it can
//                      serve them, else they are reported unavailable. Its models
//                      report toolCalling=false.
//
// THE EGRESS RULE: the server may reach exactly the active provider's host and,
// only while Copilot is on, the Copilot hosts ({@link allowedHostsFor}), besides
// loopback, which is always allowed.
// =============================================================================

/** The KVOX_SETTINGS system namespace. */
export const DESKTOP_AI_NAMESPACE = 'desktopAi';

/** The KVOX_SECRETS purpose the provider keys are stored under (the name is the provider id). */
export const AI_KEY_PURPOSE = 'ai';

/** The provider slots, in the settings page's order. */
export const DESKTOP_AI_PROVIDER_IDS = ['openai', 'openai-compatible', 'copilot'] as const;
export type DesktopAiProviderId = (typeof DESKTOP_AI_PROVIDER_IDS)[number];

/** The slots that may be the PRIMARY provider (Copilot is an add-on, never the primary). */
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
  /** True for a slot the user may choose as THE provider; false for an add-on (Copilot), which has its own switch. */
  primary: boolean;
  /** A one-line note the settings page shows under the slot. */
  note: string;
}

export const DESKTOP_AI_PROVIDERS: readonly DesktopAiProviderSlot[] = [
  { id: 'openai', label: 'OpenAI', implemented: true, toolCalling: true, primary: true, note: 'Uses api.openai.com with your OpenAI API key.' },
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible server',
    implemented: true,
    toolCalling: true,
    primary: true,
    note: 'A server that speaks the OpenAI API (Ollama, vLLM, LM Studio, a gateway). Only its host is reachable.',
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    implemented: true,
    toolCalling: false,
    primary: false,
    note: 'Opt-in add-on. Notes, knowledge extraction and the name check run on your own Copilot subscription; Ask needs an OpenAI key.',
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

/** Copilot off, no consent, no model chosen. */
export const DEFAULT_COPILOT_SETTINGS: CopilotSettings = { ...COPILOT_DEFAULT_SETTINGS };

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
  /**
   * The Copilot add-on (marinoscar/kvox#631's schema). A stored `{ enabled: false }` from before
   * the adapter existed parses to the defaults: off, no consent. Nothing here ever turns it on.
   */
  copilot: CopilotSettingsSchema.default(() => ({ ...DEFAULT_COPILOT_SETTINGS })),
});

export type DesktopAiSettings = z.infer<typeof desktopAiSettingsSchema>;

export const DEFAULT_DESKTOP_AI_SETTINGS: DesktopAiSettings = {
  provider: 'openai',
  openai: { model: DEFAULT_OPENAI_MODEL },
  openaiCompatible: { baseUrl: null, model: null, apiStyle: 'chat_completions', requiresKey: true },
  copilot: { ...DEFAULT_COPILOT_SETTINGS },
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
 * Whether the Copilot add-on is on: the user switched it on AND consented to the
 * CURRENT consent text. A stored `enabled: true` with an older consent version is
 * off until the user consents again.
 */
export function copilotActive(settings: DesktopAiSettings): boolean {
  const { enabled, consentedAt, consentVersion } = settings.copilot;
  return enabled && consentedAt !== null && consentVersion === COPILOT_CONSENT_VERSION;
}

/**
 * The hosts the server may reach under these settings: the active provider's
 * host, plus the Copilot hosts while (and only while) Copilot is on, and GitHub's release
 * hosts while (and only while) its one-time runtime download runs. A server on
 * this device needs no entry (loopback is always allowed), so it answers an empty
 * list.
 */
export function allowedHostsFor(settings: DesktopAiSettings, options: { runtimeDownload?: boolean } = {}): string[] {
  const hosts: string[] = [];
  if (settings.provider === 'openai') hosts.push(OPENAI_HOST);
  else if (settings.provider === 'openai-compatible' && settings.openaiCompatible.baseUrl) {
    const host = new URL(settings.openaiCompatible.baseUrl).hostname;
    if (!isLoopback(host)) hosts.push(host);
  }
  if (copilotActive(settings)) {
    for (const host of COPILOT_EGRESS_HOSTS) if (!hosts.includes(host)) hosts.push(host);
    // The one-time runtime download (GitHub's release hosts), for as long as it runs.
    if (options.runtimeDownload) for (const host of COPILOT_RUNTIME_DOWNLOAD_HOSTS) if (!hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}
