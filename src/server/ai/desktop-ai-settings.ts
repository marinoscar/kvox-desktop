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
// THE PROVIDER IS ONE CHOICE OF THREE, NEVER OFF:
//   openai             api.openai.com; the default. Needs the user's OpenAI key.
//   openai-compatible  a server the user names (Ollama, vLLM, LM Studio, a
//                      gateway): base URL, model, wire style, keyless or not.
//   copilot            GitHub Copilot (marinoscar/kvox#581, marinoscar/kvox-desktop#21),
//                      the user's own subscription after they sign in. It can be
//                      chosen only after the user's consent to the CURRENT text
//                      ({@link copilotActive}). It serves the tasks it can (notes,
//                      titles, graph extraction, the name check, and Ask through
//                      the adapter's tool bridge); the rest (the embeddings of
//                      search by meaning, and Ask for a model the live listing
//                      marks as tool-less) go to the OpenAI slot when an OpenAI
//                      key is stored, else they are reported unavailable. Its
//                      models report toolCalling as the adapter's catalog does.
//
// `copilot.enabled` stays in the stored shape (the packaged Copilot card reads it
// through `CopilotSettings`) but is DERIVED: always `provider === 'copilot'`. The
// parse enforces it, and `DesktopAi.update` normalises every write.
//
// STORED VALUES FROM BEFORE are migrated when parsed ({@link migrateStoredSettings}):
// `provider: null` ("Off") reads as `openai`, and a stored `copilot.enabled: true`
// with the current consent (the old add-on switch) reads as `provider: 'copilot'`.
//
// THE EGRESS RULE: the server may reach exactly the active provider's host (with
// Copilot: the Copilot hosts, plus api.openai.com only while an OpenAI key is stored
// for search by meaning) ({@link allowedHostsFor}), besides loopback, which is always allowed.
// =============================================================================

/** The KVOX_SETTINGS system namespace. */
export const DESKTOP_AI_NAMESPACE = 'desktopAi';

/** The KVOX_SECRETS purpose the provider keys are stored under (the name is the provider id). */
export const AI_KEY_PURPOSE = 'ai';

/** The values of the `provider` setting, in the settings page's order. */
export const AI_PROVIDER_IDS = ['openai', 'openai-compatible', 'copilot'] as const;
export type DesktopAiProviderId = (typeof AI_PROVIDER_IDS)[number];

/** The slots that hold an API key and have a key-based adapter (Copilot signs in instead). */
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
  /** True for a slot the user may choose as THE provider (every slot now). */
  primary: boolean;
  /** A one-line note the settings page shows under the slot. */
  note: string;
}

export const DESKTOP_AI_PROVIDERS: readonly DesktopAiProviderSlot[] = [
  { id: 'openai', label: 'OpenAI', implemented: true, toolCalling: true, primary: true, note: 'Your OpenAI API key.' },
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible server',
    implemented: true,
    toolCalling: true,
    primary: true,
    note: 'A server on this computer or your network that speaks the OpenAI API (Ollama, LM Studio, vLLM, a gateway).',
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    implemented: true,
    toolCalling: true,
    primary: true,
    note: 'Your own GitHub Copilot subscription, after you sign in. Search by meaning needs an OpenAI API key.',
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

/** No consent, no model chosen, not the provider. */
export const DEFAULT_COPILOT_SETTINGS: CopilotSettings = { ...COPILOT_DEFAULT_SETTINGS };

const desktopAiSettingsShape = z.object({
  /** The AI provider: one of three, never off. */
  provider: z.enum(AI_PROVIDER_IDS),
  openai: z.object({ model: modelId }),
  openaiCompatible: z.object({
    baseUrl: baseUrl.nullable(),
    model: modelId.nullable(),
    apiStyle: z.enum(['chat_completions', 'responses']),
    /** False for a server that takes no key (a local Ollama). */
    requiresKey: z.boolean(),
  }),
  /**
   * The Copilot settings (marinoscar/kvox#631's schema). `enabled` is derived: `provider === 'copilot'`
   * ({@link migrateStoredSettings} sets it on every parse). A stored `{ enabled: false }` from before
   * the adapter existed parses to the defaults: no consent, no model.
   */
  copilot: CopilotSettingsSchema.default(() => ({ ...DEFAULT_COPILOT_SETTINGS })),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether the user consented to the CURRENT consent text (an older version counts as no consent). */
export function copilotConsentCurrent(copilot: Pick<CopilotSettings, 'consentedAt' | 'consentVersion'>): boolean {
  return Boolean(copilot.consentedAt) && copilot.consentVersion === COPILOT_CONSENT_VERSION;
}

/**
 * Brings a stored value (or a merged patch) to the one-of-three model before it is validated:
 *
 *   - a `copilot.enabled: true` with the current consent (the old "Copilot add-on is on") becomes
 *     `provider: 'copilot'`, whatever the old primary provider was;
 *   - otherwise a `null` or missing `provider` (the old "Off") becomes `openai`;
 *   - then `copilot.enabled` is set to `provider === 'copilot'`.
 *
 * An old `enabled: true` with an OLDER consent version leaves the provider alone (and `enabled`
 * becomes false), as that Copilot was already off. Any value that is not an object passes through
 * for the schema to refuse. A write that sets `provider` also sets `copilot.enabled` itself
 * (`DesktopAi.update`), so this rule never overrides a provider the user just chose.
 */
export function migrateStoredSettings(input: unknown): unknown {
  if (!isRecord(input)) return input;
  const copilot = isRecord(input.copilot) ? input.copilot : {};
  let provider = input.provider;
  if (copilot.enabled === true && copilotConsentCurrent({ consentedAt: copilot.consentedAt as string | null, consentVersion: copilot.consentVersion as string | null })) {
    provider = 'copilot';
  } else if (provider === null || provider === undefined) {
    provider = 'openai';
  }
  return { ...input, provider, copilot: { ...copilot, enabled: provider === 'copilot' } };
}

export const desktopAiSettingsSchema = z.preprocess(migrateStoredSettings, desktopAiSettingsShape);

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

/**
 * The key-holding slot that serves the tasks Copilot cannot (the embeddings; Ask on a tool-less model), or every
 * task when Copilot is not the provider: the chosen slot, and `openai` while Copilot is chosen.
 */
export function nonCopilotSlot(settings: DesktopAiSettings): SelectableAiProviderId {
  return settings.provider === 'copilot' ? 'openai' : settings.provider;
}

/** The model of {@link nonCopilotSlot}, or `null` when it has none configured. */
export function activeModel(settings: DesktopAiSettings): string | null {
  if (nonCopilotSlot(settings) === 'openai') return settings.openai.model;
  return settings.openaiCompatible.baseUrl ? settings.openaiCompatible.model : null;
}

/** Whether a provider's calls need a stored key under these settings. */
export function needsKey(provider: SelectableAiProviderId, settings: DesktopAiSettings): boolean {
  return provider === 'openai' || settings.openaiCompatible.requiresKey;
}

/**
 * Whether Copilot is the provider in effect: the user chose it AND consented to the
 * CURRENT consent text. A stored `provider: 'copilot'` with an older consent version
 * is inactive until the user consents again (the tasks then go to the OpenAI slot).
 */
export function copilotActive(settings: DesktopAiSettings): boolean {
  return settings.provider === 'copilot' && copilotConsentCurrent(settings.copilot);
}

/**
 * The hosts the server may reach under these settings: the chosen provider's host
 * (with Copilot: the Copilot hosts, plus api.openai.com only when `openaiKey` says an
 * OpenAI key is stored, for the tasks Copilot cannot serve), and GitHub's release
 * hosts while (and only while) Copilot's one-time runtime download runs. A server on
 * this device needs no entry (loopback is always allowed), so it answers an empty
 * list.
 */
export function allowedHostsFor(settings: DesktopAiSettings, options: { runtimeDownload?: boolean; openaiKey?: boolean } = {}): string[] {
  const hosts: string[] = [];
  const add = (host: string) => {
    if (!hosts.includes(host)) hosts.push(host);
  };
  if (settings.provider === 'openai') add(OPENAI_HOST);
  else if (settings.provider === 'openai-compatible' && settings.openaiCompatible.baseUrl) {
    const host = new URL(settings.openaiCompatible.baseUrl).hostname;
    if (!isLoopback(host)) add(host);
  } else if (settings.provider === 'copilot') {
    if (copilotActive(settings)) {
      for (const host of COPILOT_EGRESS_HOSTS) add(host);
    }
    // The embeddings (search by meaning) go to OpenAI, but only once its key is stored.
    if (options.openaiKey) add(OPENAI_HOST);
    // The one-time runtime download (the npm registry host), for as long as it runs.
    if (copilotActive(settings) && options.runtimeDownload) for (const host of COPILOT_RUNTIME_DOWNLOAD_HOSTS) add(host);
  }
  return hosts;
}
