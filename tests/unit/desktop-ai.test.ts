import { EventEmitter } from 'node:events';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { Prisma } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createScriptedRuntime, describeKvoxAiConformance, type KvoxAiConformanceProvider } from '@marinoscar/kvox-ai/testing';
import type { KvoxAiContext } from '@marinoscar/kvox-api/ports';
import { COPILOT_EGRESS_HOSTS } from '@marinoscar/kvox-ai/copilot';
import { COPILOT_RUNTIME_DOWNLOAD_HOSTS } from '../../src/server/ai/copilot-sandbox';
import type { AiProviderAdapter } from '@marinoscar/platform-ai-providers';

import { COPILOT_CONSENT_VERSION } from '@marinoscar/kvox-contract/copilot';
import type { CopilotHost } from '../../src/server/ai/copilot-host';
import {
  AI_KEY_PURPOSE,
  DEFAULT_DESKTOP_AI_SETTINGS,
  DESKTOP_AI_NAMESPACE,
  DESKTOP_AI_PROVIDERS,
  DESKTOP_AI_SETTINGS_NAMESPACE,
  desktopAiSettingsSchema,
  type DesktopAiSettings,
} from '../../src/server/ai/desktop-ai-settings';
import { DesktopAi, loadProviderAdapters, type DesktopAiAdapters } from '../../src/server/ai/desktop-ai';
import { DesktopAiController } from '../../src/server/desktop-ai.controller';
import { EgressGuard } from '../../src/server/egress-guard';
import { PgSettings } from '../../src/server/ports/pg-settings';
import { SafeStorageSecrets } from '../../src/server/ports/safe-storage-secrets';
import { LOCAL_USER_ID } from '../../src/server/seed';
import { currentConsent, enableCopilot, mockCopilotHost } from '../support/configure-copilot';
import { startOpenAiCompatibleMock, type OpenAiCompatibleMock } from '../support/openai-compatible-mock';
import { fakeCipher, openTestDatabase, type TestDatabase } from './support/database';

// =============================================================================
// KVOX_AI on Desktop: createKvoxAi over createDirectRuntime (marinoscar/kvox#584)
// =============================================================================
//
// One block per acceptance criterion of the issue:
//
//   1. THE BINDING IS THE PACKAGE'S. `describeKvoxAiConformance` (the model rules
//      of the port) runs over `DesktopAi` exactly as bootstrap.ts builds it (the
//      PGlite settings, the safeStorage secrets), with only the provider adapter
//      scripted. Nothing is opted out.
//   2. OPENAI FIRST, FOR REAL. The platform's OpenAI-compatible adapter, loaded
//      the way the app loads it, generates text from a loopback server; the key
//      comes from KVOX_SECRETS on every call and the provider is the only one to
//      receive it.
//   3. THE ALLOWLIST FOLLOWS THE SETTINGS: only the active provider's host.
//   4. KEYS STAY IN KVOX_SECRETS: a planted key-shaped string is in no setting,
//      response, log line, error or file outside the encrypted blob.
//   5. COPILOT IS ONE OF THREE PROVIDERS (marinoscar/kvox-desktop#21): the
//      provider is never off; Copilot is not even loaded until it is chosen, is
//      never chosen without consent, is routed by capability (notes and Ask on
//      Copilot, Ask through the adapter's tool bridge; the embeddings of search
//      by meaning on OpenAI when a key is stored), closes the bridge's held
//      sessions when it stops, is signed
//      in through the endpoints, and holds no token anywhere. Stored settings
//      from the add-on days migrate on read.
// =============================================================================

const PLANTED_KEY = 'sk-proj-PLANTEDkvox584DoNotLeakAbCdEf0123456789';
const CTX: KvoxAiContext = { userId: LOCAL_USER_ID, orgId: null, feature: 'notes.generate' };

let db: TestDatabase;
let settings: PgSettings;
let secrets: SafeStorageSecrets;
const logLines: string[] = [];

beforeAll(async () => {
  db = await openTestDatabase();
  settings = new PgSettings(db.prisma);
  // The slices' `ai` namespace, as bootstrap.ts declares it.
  settings.registerNamespace({
    scope: 'system',
    name: 'ai',
    schema: z.object({
      maxInputTokens: z.number().nullable(),
      maxOutputTokens: z.number().nullable(),
      maxDocumentBytes: z.number(),
      // On by default, as bootstrap.ts declares it: Ask and the graph tasks are graph features.
      graphEnabled: z.boolean().default(true),
    }),
    defaults: { maxInputTokens: null, maxOutputTokens: null, maxDocumentBytes: 10 * 1024 * 1024, graphEnabled: true },
  });
  settings.registerNamespace(DESKTOP_AI_SETTINGS_NAMESPACE);
  secrets = new SafeStorageSecrets({ file: join(db.userDataDir, 'secrets.bin'), cipher: fakeCipher(), log: (line) => logLines.push(line) });
  // DesktopAi registers it too; the hooks below write keys before any instance exists.
  secrets.registerPurpose(AI_KEY_PURPOSE, 'AI provider API keys');
});

afterAll(async () => {
  await db?.close();
});

/** Puts the settings back to the defaults (a JSON Merge Patch of every field). */
async function resetSettings(patch: Partial<DesktopAiSettings> = {}): Promise<void> {
  await settings.patchSystem(DESKTOP_AI_NAMESPACE, { ...DEFAULT_DESKTOP_AI_SETTINGS, ...patch }, { actorUserId: LOCAL_USER_ID });
}

const created: DesktopAi[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((ai) => ai.close()));
});

function desktopAi(
  adapters: Readonly<Record<string, AiProviderAdapter>>,
  extra: { requestTimeoutMs?: number; hosts?: string[][]; copilot?: CopilotHost } = {},
): DesktopAi {
  const ai = new DesktopAi({
    settings,
    secrets,
    adapters,
    ...(extra.copilot ? { copilot: extra.copilot } : {}),
    log: (line) => logLines.push(line),
    onAllowedHosts: (hosts) => {
      extra.hosts?.push(hosts);
      logLines.push(`server: egress allowlist is loopback and ${hosts.join(', ')}`);
    },
    ...(extra.requestTimeoutMs !== undefined ? { requestTimeoutMs: extra.requestTimeoutMs } : {}),
  });
  created.push(ai);
  return ai;
}

async function collectText(ai: DesktopAi): Promise<string> {
  const target = await ai.port.resolveTask(CTX, 'notes.generate');
  let text = '';
  for await (const event of ai.port.generateText(CTX, { target, system: 'Write notes.', user: 'Joe sends the budget by Friday.' })) {
    if (event.type === 'delta') text += event.text;
  }
  return text;
}

// ---- 1. The model rules of the port, over the Desktop binding ------------------

/** An `AiProviderAdapter` that replays the package's scripted runtime (the provider is the only stand-in). */
function scriptedAdapter(): { adapter: AiProviderAdapter; provider: KvoxAiConformanceProvider } {
  const runtime = createScriptedRuntime();
  const call = (signal: AbortSignal | undefined) => ({ userId: LOCAL_USER_ID, feature: 'note_generate' as const, ...(signal ? { signal } : {}) });
  const adapter = {
    id: 'openai',
    displayName: 'Scripted OpenAI',
    responses: {
      stream: (req, ctx) => runtime.stream(call(ctx.signal), req),
      create: (req, ctx) => runtime.create(call(ctx.signal), req),
    },
  } as AiProviderAdapter;
  const provider: KvoxAiConformanceProvider = {
    structuredAnswer: ({ value, finishReason }) =>
      runtime.queueCreate({ response: { parsed: value, ...(finishReason !== undefined ? { finishReason } : {}) } }),
    streamAnswer: (events) => runtime.queueStream({ events }),
    failNext: (error) => runtime.failNext(error),
    hangNext: () => runtime.hangNext(),
    lastStructuredRequest: () => {
      const last = [...runtime.calls].reverse().find((record) => record.kind === 'create');
      return (last?.request as { structuredOutput?: { name: string; schema: unknown; strict: boolean } } | undefined)?.structuredOutput;
    },
  };
  return { adapter, provider };
}

describe('KVOX_AI conformance', () => {
  beforeEach(async () => {
    await resetSettings();
    await secrets.set(AI_KEY_PURPOSE, 'openai', PLANTED_KEY, LOCAL_USER_ID);
  });

  describeKvoxAiConformance(
    'DesktopAi (createKvoxAi over createDirectRuntime, KVOX_SECRETS keys, desktopAi settings)',
    (options) => {
      const { adapter, provider } = scriptedAdapter();
      const ai = desktopAi({ openai: adapter }, options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {});
      return { port: ai.port, provider, userId: LOCAL_USER_ID };
    },
    { describe, it, expect },
  );
});

// ---- 2-5. The real adapters, the allowlist, the keys, the Copilot slot ----------

describe('DesktopAi over the platform adapters', () => {
  let providers: DesktopAiAdapters;
  let mock: OpenAiCompatibleMock;
  const NOTE = '# Stand-up\n\n- Joe sends the budget by Friday.\n';

  beforeAll(async () => {
    providers = await loadProviderAdapters();
    mock = await startOpenAiCompatibleMock(NOTE);
  });
  afterAll(async () => {
    await providers?.close();
    await mock?.close();
  });
  beforeEach(async () => {
    await resetSettings();
    for (const id of ['openai', 'openai-compatible']) await secrets.delete(AI_KEY_PURPOSE, id);
    mock.requests.length = 0;
  });

  it('loads the OpenAI and OpenAI-compatible adapters from the platform', () => {
    expect(Object.keys(providers.adapters).sort()).toEqual(['openai', 'openai-compatible']);
    expect(providers.adapters.openai?.responses).toBeDefined();
  });

  it('starts on OpenAI with no key: configured, key missing, nothing sent', async () => {
    const ai = desktopAi(providers.adapters);
    const capabilities = await ai.port.capabilities(CTX);
    expect(capabilities).toMatchObject({ available: false, reason: 'ai_key_missing' });
    await expect(collectText(ai)).rejects.toMatchObject({ errorClass: 'key_missing' });
    const target = await ai.port.resolveTask(CTX, 'notes.generate', { requireKey: false });
    expect(target).toMatchObject({ provider: 'openai', model: DEFAULT_DESKTOP_AI_SETTINGS.openai.model });
  });

  it('generates a note through the OpenAI-compatible adapter with the key from KVOX_SECRETS, read per call', async () => {
    const ai = desktopAi(providers.adapters);
    await ai.update({ provider: 'openai-compatible', openaiCompatible: { baseUrl: `${mock.baseUrl}/`, model: 'mock-model' } }, LOCAL_USER_ID);
    await ai.setKey('openai-compatible', PLANTED_KEY, LOCAL_USER_ID);

    expect(await collectText(ai)).toBe(NOTE);
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]).toMatchObject({ path: '/v1/chat/completions', authorization: `Bearer ${PLANTED_KEY}` });
    expect(mock.requests[0]?.body).toMatchObject({ model: 'mock-model', stream: true });

    // Removing the key takes effect on the very next call: nothing is cached.
    await ai.deleteKey('openai-compatible', LOCAL_USER_ID);
    await expect(collectText(ai)).rejects.toMatchObject({ errorClass: 'key_missing' });
    expect(mock.requests).toHaveLength(1);
  });

  it('runs a keyless OpenAI-compatible server without a stored key', async () => {
    const ai = desktopAi(providers.adapters);
    await ai.update({ provider: 'openai-compatible', openaiCompatible: { baseUrl: mock.baseUrl, model: 'llama', requiresKey: false } }, LOCAL_USER_ID);
    expect(await collectText(ai)).toBe(NOTE);
    expect(mock.requests[0]?.authorization ?? '').not.toContain('sk-');
  });

  it('narrows the egress allowlist to the active provider host, and only that host', async () => {
    const guard = new EgressGuard({ logError: () => undefined });
    const ai = new DesktopAi({ settings, secrets, adapters: providers.adapters, onAllowedHosts: (hosts) => guard.allow(hosts) });

    expect(await ai.applyEgress()).toEqual(['api.openai.com']);
    expect(guard.isAllowed('api.openai.com')).toBe(true);

    await ai.update({ provider: 'openai-compatible', openaiCompatible: { baseUrl: 'https://llm.corp.example:8443/v1', model: 'm' } }, LOCAL_USER_ID);
    expect(guard.allowedHosts).toEqual(['llm.corp.example']);
    expect(guard.isAllowed('llm.corp.example')).toBe(true);
    expect(guard.isAllowed('api.openai.com')).toBe(false);
    expect(guard.isAllowed('example.com')).toBe(false);

    // A server on this device needs no entry: loopback is always allowed.
    await ai.update({ openaiCompatible: { baseUrl: 'http://[::1]:11434/v1' } }, LOCAL_USER_ID);
    expect(guard.allowedHosts).toEqual([]);
    expect(guard.isAllowed('llm.corp.example')).toBe(false);

    expect(guard.isAllowed('127.0.0.1')).toBe(true);

    await ai.update({ provider: 'openai' }, LOCAL_USER_ID);
    expect(guard.allowedHosts).toEqual(['api.openai.com']);
    expect(guard.isAllowed('llm.corp.example')).toBe(false);
  });

  it('never turns the provider off: an explicit null is refused, and a read of an old null is OpenAI', async () => {
    const ai = desktopAi(providers.adapters);
    await expect(ai.update({ provider: null }, LOCAL_USER_ID)).rejects.toMatchObject({ status: 400, response: { code: 'ai_settings_invalid' } });
    await expect(ai.update({ provider: 'anthropic' }, LOCAL_USER_ID)).rejects.toMatchObject({ status: 400 });
    expect((await ai.read()).provider).toBe('openai');
  });

  it('refuses a base URL with credentials, a query or a non-http scheme, and keeps the allowlist', async () => {
    const hosts: string[][] = [];
    const ai = desktopAi(providers.adapters, { hosts });
    for (const baseUrl of ['https://user:pw@llm.example/v1', 'https://llm.example/v1?x=1', 'file:///etc/passwd', 'not a url']) {
      await expect(ai.update({ openaiCompatible: { baseUrl } }, LOCAL_USER_ID)).rejects.toMatchObject({ status: 400 });
    }
    expect(hosts).toEqual([]);
  });

  it('keeps a planted key out of every setting, response, log line, error and plaintext file', async () => {
    const egress = new EgressGuard({ logError: (line) => logLines.push(line) });
    const ai = new DesktopAi({ settings, secrets, adapters: providers.adapters, onAllowedHosts: (hosts) => egress.allow(hosts) });
    const controller = new DesktopAiController(ai.port, ai, egress);
    await ai.update({ provider: 'openai-compatible', openaiCompatible: { baseUrl: mock.baseUrl, model: 'mock-model' } }, LOCAL_USER_ID);
    const status = await controller.setKey({ userId: LOCAL_USER_ID, orgId: db.orgId } as never, 'openai-compatible', { apiKey: PLANTED_KEY });
    expect(status).toMatchObject({ configured: true, hint: `…${PLANTED_KEY.slice(-4)}` });

    // A provider that echoes the key in its error body (the package classifies the rejected key).
    mock.failWith(401);
    const failure = (await collectText(ai).catch((error: unknown) => error)) as Error & { errorClass?: string };
    expect(mock.requests.at(-1)?.authorization).toBe(`Bearer ${PLANTED_KEY}`);
    expect(failure.name).toBe('KvoxAiError');
    expect(['auth', 'key_missing']).toContain(failure.errorClass);

    const surfaces = {
      error: `${failure.name}: ${failure.message} ${JSON.stringify(failure)} ${failure.stack ?? ''}`,
      settingsView: JSON.stringify(await controller.settings()),
      notesState: JSON.stringify(await controller.state({ userId: LOCAL_USER_ID, orgId: db.orgId } as never)),
      settingsRows: JSON.stringify(await db.prisma.$queryRaw(Prisma.sql`SELECT * FROM system_settings`)),
      logs: logLines.join('\n'),
      capabilities: JSON.stringify(await ai.port.capabilities(CTX)),
    };
    for (const [surface, text] of Object.entries(surfaces)) {
      expect(text, surface).not.toContain(PLANTED_KEY);
      expect(text, surface).not.toContain('PLANTEDkvox584');
    }

    // On disk only the encrypted blob exists (the fake cipher reverses base64, so no plaintext copy).
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else files.push(path);
      }
    };
    walk(db.userDataDir);
    for (const file of files) expect(readFileSync(file).includes(Buffer.from('PLANTEDkvox584')), file).toBe(false);
  });

  it('refuses a malformed key without echoing it', async () => {
    const ai = desktopAi(providers.adapters);
    const malformed = 'sk-has spaces PLANTEDkvox584';
    const error = (await ai.setKey('openai', malformed, LOCAL_USER_ID).catch((e: unknown) => e)) as Error & { getResponse(): unknown };
    expect(error).toMatchObject({ status: 400 });
    expect(JSON.stringify(error.getResponse()) + error.message).not.toContain('PLANTEDkvox584');
    expect((await ai.keyStatus('openai')).configured).toBe(false);
  });

  // ---- The key test: POST /desktop/ai/keys/:provider/test ------------------------

  describe('key test', () => {
    const useMock = async (ai: DesktopAi) =>
      ai.update({ provider: 'openai-compatible', openaiCompatible: { baseUrl: mock.baseUrl, model: 'mock-model', requiresKey: true } }, LOCAL_USER_ID);

    it('verifies the typed key with the adapter, counts the models and never echoes the key', async () => {
      const ai = desktopAi(providers.adapters);
      await useMock(ai);
      const result = await ai.testKey('openai-compatible', PLANTED_KEY);
      expect(result).toMatchObject({ success: true, provider: 'openai-compatible', usedStoredKey: false, modelCount: 1 });
      expect(result.checks.map((check) => [check.id, check.status])).toEqual([
        ['credentials', 'passed'],
        ['list_models', 'passed'],
      ]);
      expect(mock.requests.length).toBeGreaterThan(0);
      for (const request of mock.requests) expect(request).toMatchObject({ authorization: `Bearer ${PLANTED_KEY}` });
      expect(JSON.stringify(result)).not.toContain('PLANTEDkvox584');
      // Testing stores nothing.
      expect((await ai.keyStatus('openai-compatible')).configured).toBe(false);
    });

    it('re-checks the stored key when none is typed', async () => {
      const ai = desktopAi(providers.adapters);
      await useMock(ai);
      await ai.setKey('openai-compatible', PLANTED_KEY, LOCAL_USER_ID);
      const result = await new DesktopAiController(ai.port, ai, new EgressGuard({ logError: () => undefined })).testKey('openai-compatible', {});
      expect(result).toMatchObject({ success: true, usedStoredKey: true });
      expect(mock.requests[0]).toMatchObject({ authorization: `Bearer ${PLANTED_KEY}` });
      expect(JSON.stringify(result)).not.toContain('PLANTEDkvox584');
    });

    it('answers an invalid key as a failed check (200, not an exception) without echoing it', async () => {
      const ai = desktopAi(providers.adapters);
      await useMock(ai);
      mock.failWith(401); // the provider's body echoes the bearer token
      const result = await ai.testKey('openai-compatible', PLANTED_KEY);
      expect(result.success).toBe(false);
      expect(result.checks[0]).toMatchObject({ id: 'credentials', status: 'failed', code: 'AI_KEY_INVALID' });
      expect(JSON.stringify(result)).not.toContain('PLANTEDkvox584');
    });

    it('refuses a host the egress guard blocks, with a readable result and no request', async () => {
      const logs: string[] = [];
      const guard = new EgressGuard({ logError: (line) => logs.push(line) });
      const ai = new DesktopAi({
        settings,
        secrets,
        adapters: providers.adapters,
        onAllowedHosts: (hosts) => guard.allow(hosts),
        checkEgress: (host) => guard.check(host),
      });
      await ai.update({ provider: 'openai-compatible', openaiCompatible: { baseUrl: 'https://llm.corp.example:8443/v1', model: 'm' } }, LOCAL_USER_ID);
      // Testing the slot that is not the active provider: its host is not on the allowlist.
      const result = await ai.testKey('openai', PLANTED_KEY);
      expect(result.success).toBe(false);
      expect(result.checks[0]).toMatchObject({ status: 'failed', code: 'AI_PROVIDER_UNAVAILABLE' });
      expect(result.checks[0]?.detail).toMatch(/blocked the connection to api\.openai\.com/);
      expect(logs.join('\n')).toContain('egress blocked: api.openai.com');
      expect(JSON.stringify(result) + logs.join('\n')).not.toContain('PLANTEDkvox584');
      expect(mock.requests).toEqual([]);
    });

    it('answers a missing key or server URL as a failed check, and sends nothing', async () => {
      const ai = desktopAi(providers.adapters);
      expect((await ai.testKey('openai', undefined)).checks[0]).toMatchObject({ status: 'failed', code: 'AI_KEY_REQUIRED' });
      const unconfigured = await ai.testKey('openai-compatible', PLANTED_KEY);
      expect(unconfigured.success).toBe(false);
      expect(unconfigured.checks[0]?.detail).toMatch(/base URL/);
      expect(mock.requests).toEqual([]);
    });

    it('refuses a malformed typed key, an unknown slot and Copilot without echoing the key', async () => {
      const ai = desktopAi(providers.adapters);
      const malformed = (await ai.testKey('openai', 'sk-has spaces PLANTEDkvox584').catch((e: unknown) => e)) as Error & { getResponse(): unknown };
      expect(malformed).toMatchObject({ status: 400 });
      expect(JSON.stringify(malformed.getResponse()) + malformed.message).not.toContain('PLANTEDkvox584');
      await expect(ai.testKey('copilot', PLANTED_KEY)).rejects.toMatchObject({ status: 400, response: { code: 'ai_key_not_applicable' } });
      await expect(ai.testKey('nope', PLANTED_KEY)).rejects.toMatchObject({ status: 400 });
      expect(mock.requests).toEqual([]);
    });
  });
});

// ---- 5. The settings schema's migration ----------------------------------------------

describe('desktopAi settings: the one-of-three provider and its migration', () => {
  const consent = { consentedAt: '2026-10-19T00:00:00.000Z', consentVersion: COPILOT_CONSENT_VERSION, model: null };
  const old = (provider: unknown, copilot?: unknown) => ({
    provider,
    openai: { model: 'gpt-5.4-mini' },
    openaiCompatible: { baseUrl: null, model: null, apiStyle: 'chat_completions', requiresKey: true },
    ...(copilot === undefined ? {} : { copilot }),
  });

  it.each([
    ['the defaults', 'openai', false, DEFAULT_DESKTOP_AI_SETTINGS],
    ['the old Off', 'openai', false, old(null)],
    ['a missing provider', 'openai', false, old(undefined)],
    ['the old Off with the add-on off', 'openai', false, old(null, { enabled: false })],
    ['the old OpenAI with Copilot on', 'copilot', true, old('openai', { enabled: true, ...consent })],
    ['the old compatible server with Copilot on', 'copilot', true, old('openai-compatible', { enabled: true, ...consent })],
    ['the old Off with Copilot on', 'copilot', true, old(null, { enabled: true, ...consent })],
    ['the old compatible server with Copilot on and an OLD consent', 'openai-compatible', false, old('openai-compatible', { enabled: true, ...consent, consentVersion: '0-older' })],
    ['the old OpenAI with Copilot on and no consent', 'openai', false, old('openai', { enabled: true })],
    ['the old Off with Copilot on and an OLD consent', 'openai', false, old(null, { enabled: true, ...consent, consentVersion: '0-older' })],
    ['copilot chosen, enabled absent', 'copilot', true, old('copilot', { consentedAt: consent.consentedAt, consentVersion: consent.consentVersion })],
    ['copilot chosen with a stale enabled: false', 'copilot', true, old('copilot', { enabled: false, ...consent })],
    ['openai chosen with a stale enabled: true and no consent', 'openai', false, old('openai', { enabled: true, consentedAt: null })],
  ])('reads %s as provider %s with copilot.enabled %s', (_name, provider, enabled, stored) => {
    const parsed = desktopAiSettingsSchema.parse(stored);
    expect(parsed.provider).toBe(provider);
    expect(parsed.copilot.enabled).toBe(enabled);
    // The invariant, and a second parse changes nothing.
    expect(parsed.copilot.enabled).toBe(parsed.provider === 'copilot');
    expect(desktopAiSettingsSchema.parse(parsed)).toEqual(parsed);
  });

  it('keeps the consent and the chosen model when it migrates, and the defaults of a missing copilot block', () => {
    expect(desktopAiSettingsSchema.parse(old('openai', { enabled: true, ...consent, model: GPT })).copilot).toEqual({ enabled: true, ...consent, model: GPT });
    expect(desktopAiSettingsSchema.parse(old(null)).copilot).toEqual(DEFAULT_DESKTOP_AI_SETTINGS.copilot);
    expect(DEFAULT_DESKTOP_AI_SETTINGS).toMatchObject({ provider: 'openai', copilot: { enabled: false } });
  });

  it('refuses a provider that is not one of the three, and anything that is not an object', () => {
    for (const provider of ['anthropic', '', 0, false]) expect(desktopAiSettingsSchema.safeParse(old(provider)).success).toBe(false);
    for (const value of [null, 'openai', 3, []]) expect(desktopAiSettingsSchema.safeParse(value).success).toBe(false);
  });
});

// ---- 6. The Copilot provider -------------------------------------------------------

const CLAUDE = 'claude-haiku-4.5';
const GPT = 'gpt-5-mini';
const TOKENS = ['gho_PLANTEDcopilot0123456789abcdef', 'ghu_PLANTEDcopilot0123456789abcdef', 'github_pat_PLANTEDcopilot0123456789'];
const PRINCIPAL = { userId: LOCAL_USER_ID, orgId: null } as never;

/** A `reply` whose connection stays open until the answer is written (what the wait route reads). */
function openReply() {
  return { raw: Object.assign(new EventEmitter(), { writableFinished: false }) } as never;
}

describe('GitHub Copilot as a provider', () => {
  let providers: DesktopAiAdapters;
  let mock: OpenAiCompatibleMock;

  beforeAll(async () => {
    providers = await loadProviderAdapters();
    mock = await startOpenAiCompatibleMock('# From OpenAI\n');
  });
  afterAll(async () => {
    await providers?.close();
    await mock?.close();
  });
  beforeEach(async () => {
    await resetSettings();
    for (const id of ['openai', 'openai-compatible']) await secrets.delete(AI_KEY_PURPOSE, id);
    mock.requests.length = 0;
    logLines.length = 0;
  });

  function setup(options: Parameters<typeof mockCopilotHost>[0] = {}) {
    const harness = mockCopilotHost(options);
    const guard = new EgressGuard({ logError: (line) => logLines.push(line) });
    // The egress wiring of bootstrap.ts: every settings change feeds the guard.
    const wired = new DesktopAi({
      settings,
      secrets,
      adapters: providers.adapters,
      copilot: harness.host,
      log: (line) => logLines.push(line),
      onAllowedHosts: (hosts) => guard.allow(hosts),
    });
    created.push(wired);
    const controller = new DesktopAiController(wired.port, wired, guard);
    return { ...harness, ai: wired, guard, controller };
  }

  it('is one of three provider choices, holds no key, and is never chosen without consent', async () => {
    const { ai, controller } = setup();
    const view = await controller.settings();
    expect(view.providers.map((p) => p.id)).toEqual(['openai', 'openai-compatible', 'copilot']);
    expect(view.providers.map((p) => p.primary)).toEqual([true, true, true]);
    expect(view.providers.find((p) => p.id === 'copilot')).toMatchObject({ implemented: true, primary: true, toolCalling: true, key: null, needsKey: false });
    expect(DESKTOP_AI_PROVIDERS.find((p) => p.id === 'copilot')).toMatchObject({
      implemented: true,
      toolCalling: true,
      note: 'Your own GitHub Copilot subscription, after you sign in. Search by meaning needs an OpenAI API key.',
    });
    expect(view.settings.provider).toBe('openai');

    // Choosing it without the consent is refused, and nothing is written.
    await expect(ai.update({ provider: 'copilot' }, LOCAL_USER_ID)).rejects.toMatchObject({ status: 409, response: { code: 'consent_required' } });
    expect((await ai.read()).provider).toBe('openai');
    // It has no API key to store.
    await expect(ai.setKey('copilot', 'gho_abcdefghijklmnop', LOCAL_USER_ID)).rejects.toMatchObject({
      status: 400,
      response: { code: 'ai_key_not_applicable' },
    });
  });

  it('migrates what the add-on days stored: the old Off, and the old switch, read as the new provider', async () => {
    const consent = { consentedAt: '2026-10-19T00:00:00.000Z', consentVersion: COPILOT_CONSENT_VERSION, model: GPT };
    const store = (value: unknown) =>
      db.prisma.systemSettings.upsert({
        where: { key: DESKTOP_AI_NAMESPACE },
        update: { value: value as Prisma.InputJsonValue },
        create: { key: DESKTOP_AI_NAMESPACE, value: value as Prisma.InputJsonValue, version: 1, updatedByUserId: LOCAL_USER_ID },
      });
    const { ai, controller, calls } = setup({ signedIn: true });

    // Before Copilot existed as an adapter: `{ enabled: false }` reads as the defaults.
    await store({ ...DEFAULT_DESKTOP_AI_SETTINGS, copilot: { enabled: false } });
    expect((await ai.read()).copilot).toEqual({ enabled: false, consentedAt: null, consentVersion: null, model: null });
    await ai.start();
    expect(calls.prepared).toBe(0);
    expect(await controller.copilotStatus()).toMatchObject({ enabled: false, signedIn: false, models: [], unavailableTasks: [] });

    // A row with no copilot key at all reads the same.
    const bare = { provider: 'openai', openai: { model: 'gpt-5.4-mini' }, openaiCompatible: DEFAULT_DESKTOP_AI_SETTINGS.openaiCompatible };
    await store(bare);
    expect((await ai.read()).copilot).toEqual(DEFAULT_DESKTOP_AI_SETTINGS.copilot);

    // The old Off (provider null) is OpenAI.
    await store({ ...bare, provider: null });
    expect((await ai.read()).provider).toBe('openai');

    // The old "OpenAI + Copilot on" is Copilot, and start-up brings it up from the stored row alone.
    await store({ ...bare, provider: 'openai', copilot: { enabled: true, ...consent } });
    expect(await ai.read()).toMatchObject({ provider: 'copilot', copilot: { enabled: true, ...consent } });
    await ai.start();
    expect(ai.copilot.ready).toBe(true);
    expect(await controller.copilotStatus()).toMatchObject({ enabled: true });

    // The old "compatible + Copilot on" with an OLD consent was off: it stays the compatible server.
    await store({ ...bare, provider: 'openai-compatible', copilot: { enabled: true, ...consent, consentVersion: '0-older' } });
    expect(await ai.read()).toMatchObject({ provider: 'openai-compatible', copilot: { enabled: false, consentVersion: '0-older' } });
    await ai.start();
    expect(ai.copilot.ready).toBe(false);

    // An unrelated write to an old "Copilot on" row keeps Copilot: the migrated value is what is saved.
    await store({ ...bare, provider: 'openai', copilot: { enabled: true, ...consent } });
    await ai.update({ openai: { model: 'gpt-5.4' } }, LOCAL_USER_ID);
    expect(await ai.read()).toMatchObject({ provider: 'copilot', openai: { model: 'gpt-5.4' }, copilot: { enabled: true } });
    expect(await db.prisma.systemSettings.findUnique({ where: { key: DESKTOP_AI_NAMESPACE } })).toMatchObject({
      value: { provider: 'copilot', copilot: { enabled: true } },
    });
  });

  it('loads nothing while Copilot is off: no adapter, no runtime, no SDK, no Copilot host in the egress list', async () => {
    const { ai, controller, calls, guard } = setup();
    await ai.start();
    await ai.applyEgress();
    expect(ai.copilot.ready).toBe(false);
    expect(providers.adapters.copilot).toBeUndefined();
    expect(calls).toEqual({ prepared: 0, downloads: 0, transports: 0, stopped: 0, removed: [] });
    expect(Object.keys(require.cache).filter((path) => path.includes('copilot-sdk'))).toEqual([]);
    for (const host of COPILOT_EGRESS_HOSTS) expect(guard.isAllowed(host)).toBe(false);
    expect((await controller.copilotStatus()).enabled).toBe(false);
  });

  it('refuses to switch on without the current consent (409 consent_required), on every route', async () => {
    const { ai, controller, calls } = setup();
    await expect(controller.copilotUpdate(PRINCIPAL, { enabled: true })).rejects.toMatchObject({ status: 409, response: { code: 'consent_required' } });
    await expect(
      controller.copilotUpdate(PRINCIPAL, { enabled: true, consentedAt: new Date().toISOString(), consentVersion: '0-old' }),
    ).rejects.toMatchObject({ status: 409, response: { code: 'consent_required' } });
    await expect(controller.patch(PRINCIPAL, { copilot: { enabled: true } })).rejects.toMatchObject({ status: 409, response: { code: 'consent_required' } });
    await expect(controller.patch(PRINCIPAL, { provider: 'copilot' })).rejects.toMatchObject({ status: 409, response: { code: 'consent_required' } });
    await expect(controller.patch(PRINCIPAL, { provider: 'copilot', copilot: { consentVersion: '0-old', consentedAt: new Date().toISOString() } })).rejects.toMatchObject({
      status: 409,
      response: { code: 'consent_required', details: { consentVersion: COPILOT_CONSENT_VERSION } },
    });
    await expect(controller.copilotUpdate(PRINCIPAL, { enabled: 'yes' })).rejects.toMatchObject({ status: 400 });
    expect(await ai.read()).toMatchObject({ provider: 'openai', copilot: { enabled: false, consentedAt: null } });
    expect(calls.prepared).toBe(0);

    // Accepting writes the consent together with `enabled: true`, which IS choosing Copilot.
    const status = await controller.copilotUpdate(PRINCIPAL, currentConsent());
    expect(status).toMatchObject({ enabled: true, runtime: { state: 'ready', version: '1.0.98' } });
    expect(await ai.read()).toMatchObject({ provider: 'copilot', copilot: { enabled: true, consentVersion: COPILOT_CONSENT_VERSION } });
    expect(ai.copilot.ready).toBe(true);
    expect(calls.prepared).toBe(1);
    expect(calls.transports).toBe(1);
    expect(providers.adapters.copilot).toBeUndefined(); // the runtime's map is the instance's own copy
  });

  it('changing the model leaves Copilot on and its consent in place (the schema defaults are never patched in)', async () => {
    const { ai, controller } = setup();
    await controller.copilotUpdate(PRINCIPAL, currentConsent());
    const before = (await ai.read()).copilot;

    const status = await controller.copilotUpdate(PRINCIPAL, { model: GPT });
    expect(status).toMatchObject({ enabled: true });
    expect((await ai.read()).copilot).toEqual({ ...before, model: GPT });
    expect(ai.copilot.ready).toBe(true);

    // Clearing the model is still a patch of the model alone, and an explicit switch-off still switches off.
    await controller.copilotUpdate(PRINCIPAL, { model: null });
    expect((await ai.read()).copilot).toEqual({ ...before, model: null });
    expect(await controller.copilotUpdate(PRINCIPAL, { enabled: false })).toMatchObject({ enabled: false });
    expect(await ai.read()).toMatchObject({ provider: 'openai', copilot: { enabled: false, model: null, consentVersion: before.consentVersion } });
  });

  it('switching to another provider takes Copilot down but keeps the consent; switching back needs no new consent', async () => {
    const { ai, controller, calls } = setup();
    await enableCopilot(ai, LOCAL_USER_ID, { model: GPT });
    const consented = (await ai.read()).copilot;
    expect(ai.copilot.ready).toBe(true);

    await ai.update({ provider: 'openai' }, LOCAL_USER_ID);
    expect(await ai.read()).toMatchObject({ provider: 'openai', copilot: { ...consented, enabled: false } });
    expect(ai.copilot.ready).toBe(false);
    expect(calls.stopped).toBe(1);
    expect(await controller.copilotStatus()).toMatchObject({ enabled: false });

    // Back to Copilot, by either route, with no consent in the request.
    await ai.update({ provider: 'copilot' }, LOCAL_USER_ID);
    expect(await ai.read()).toMatchObject({ provider: 'copilot', copilot: { ...consented, enabled: true } });
    expect(ai.copilot.ready).toBe(true);
    await ai.update({ provider: 'openai-compatible', openaiCompatible: { baseUrl: 'http://127.0.0.1:1/v1', model: 'm' } }, LOCAL_USER_ID);
    expect(ai.copilot.ready).toBe(false);
    expect(await controller.copilotUpdate(PRINCIPAL, { enabled: true })).toMatchObject({ enabled: true });
    expect((await ai.read()).provider).toBe('copilot');
    expect(ai.copilot.ready).toBe(true);
  });

  it('withdrawing the consent while Copilot is the provider returns to OpenAI; a later choice asks again', async () => {
    const { ai, controller } = setup();
    await enableCopilot(ai, LOCAL_USER_ID);

    const status = await controller.copilotUpdate(PRINCIPAL, { enabled: false, consentedAt: null, consentVersion: null });
    expect(status).toMatchObject({ enabled: false });
    expect(await ai.read()).toMatchObject({ provider: 'openai', copilot: { enabled: false, consentedAt: null, consentVersion: null } });
    expect(ai.copilot.ready).toBe(false);
    await expect(controller.copilotUpdate(PRINCIPAL, { enabled: true })).rejects.toMatchObject({ status: 409, response: { code: 'consent_required' } });
    expect((await ai.read()).provider).toBe('openai');
  });

  it('keeps provider and copilot.enabled one fact: the provider wins over a stale enabled in the same patch', async () => {
    const { ai } = setup();
    await enableCopilot(ai, LOCAL_USER_ID);
    // Leaving Copilot while the same body still says enabled: true.
    await ai.update({ provider: 'openai', copilot: { enabled: true } }, LOCAL_USER_ID);
    expect(await ai.read()).toMatchObject({ provider: 'openai', copilot: { enabled: false } });
    expect(ai.copilot.ready).toBe(false);
    // `enabled: false` while another provider is chosen changes nothing else.
    await ai.update({ provider: 'openai-compatible', openaiCompatible: { baseUrl: 'http://127.0.0.1:1/v1', model: 'm' } }, LOCAL_USER_ID);
    await ai.updateCopilot({ enabled: false }, LOCAL_USER_ID);
    expect((await ai.read()).provider).toBe('openai-compatible');
    // Giving the consent alone does not choose Copilot.
    await ai.updateCopilot({ consentedAt: new Date().toISOString(), consentVersion: COPILOT_CONSENT_VERSION }, LOCAL_USER_ID);
    expect(await ai.read()).toMatchObject({ provider: 'openai-compatible', copilot: { enabled: false } });
  });

  it('lets the runtime reach the API host of each Copilot plan while Copilot is on, and none while it is off', async () => {
    const { controller, guard } = setup();
    const planHosts = ['api.individual.githubcopilot.com', 'api.business.githubcopilot.com', 'api.enterprise.githubcopilot.com'];
    for (const host of planHosts) expect(guard.isAllowed(host)).toBe(false);
    const status = await controller.copilotUpdate(PRINCIPAL, currentConsent());
    for (const host of planHosts) {
      expect(guard.isAllowed(host)).toBe(true);
      expect(status.allowedHosts).toContain(host);
    }
    await controller.copilotUpdate(PRINCIPAL, { enabled: false });
    for (const host of planHosts) expect(guard.isAllowed(host)).toBe(false);
  });

  it('asks again when the consent text changes: an older consent version is off', async () => {
    const { ai, controller, calls, guard } = setup();
    await ai.updateCopilot(currentConsent(), LOCAL_USER_ID);
    // A newer text: the stored consent no longer matches.
    await settings.patchSystem(DESKTOP_AI_NAMESPACE, { copilot: { consentVersion: '0-older' } }, { actorUserId: LOCAL_USER_ID });
    expect(await controller.copilotStatus()).toMatchObject({ enabled: false });
    await ai.start();
    expect(ai.copilot.ready).toBe(false);
    expect(calls.stopped).toBeGreaterThan(0);

    // Copilot stays the chosen provider but is inactive: nothing of it reaches, and the user is asked again.
    expect((await ai.read()).provider).toBe('copilot');
    await ai.applyEgress();
    for (const host of COPILOT_EGRESS_HOSTS) expect(guard.isAllowed(host)).toBe(false);
    await expect(ai.updateCopilot({ model: GPT }, LOCAL_USER_ID)).rejects.toMatchObject({ status: 409, response: { code: 'consent_required' } });
    await controller.copilotUpdate(PRINCIPAL, currentConsent());
    expect(ai.copilot.ready).toBe(true);
    expect(await controller.copilotStatus()).toMatchObject({ enabled: true });
  });

  it('reports a missing runtime as a state, and refuses sign-in and download politely', async () => {
    const { ai, controller } = setup({ runtime: 'missing' });
    const status = await controller.copilotUpdate(PRINCIPAL, currentConsent());
    expect(status).toMatchObject({ enabled: true, signedIn: false, runtime: { state: 'missing', version: null, progress: null } });
    await expect(controller.copilotSignIn()).rejects.toMatchObject({ status: 409, response: { code: 'runtime_not_ready' } });
    await expect(controller.copilotRuntimeDownload()).rejects.toMatchObject({ status: 409, response: { code: 'runtime_download_unavailable', message: expect.stringContaining('test-os-x64') } });
    // Generating is refused as "not configured": there is no Copilot to send to, and nothing is sent anywhere.
    await expect(collectText(ai)).rejects.toMatchObject({ errorClass: 'not_configured' });
  });

  it('downloads the runtime on request, with progress in the status, then is ready', async () => {
    const harness = setup({ runtime: 'downloadable' });
    const { controller } = harness;
    await controller.copilotUpdate(PRINCIPAL, currentConsent());
    expect((await controller.copilotStatus()).runtime.state).toBe('missing');
    expect(harness.calls.downloads).toBe(0); // never without the user's action

    // The registry host is reachable for the download only.
    const releaseHost = COPILOT_RUNTIME_DOWNLOAD_HOSTS.find((host) => !COPILOT_EGRESS_HOSTS.includes(host))!;
    expect(harness.guard.isAllowed(releaseHost)).toBe(false);
    const started = await controller.copilotRuntimeDownload();
    expect(started.runtime).toMatchObject({ state: 'downloading', progress: 0 });
    expect(harness.guard.isAllowed(releaseHost)).toBe(true);
    harness.progress(25, 100);
    expect((await controller.copilotStatus()).runtime).toMatchObject({ state: 'downloading', progress: 0.25 });
    harness.finishDownload();
    await vi_waitFor(async () => expect((await controller.copilotStatus()).runtime.state).toBe('ready'));
    expect(harness.calls.downloads).toBe(1);
    await vi_waitFor(async () => expect(harness.guard.isAllowed(releaseHost)).toBe(false));

    // The adapter built after the download serves calls at once, with no restart.
    harness.transport.queue({ kind: 'answer', text: '# After the download\n' });
    expect(await collectText(harness.ai)).toBe('# After the download\n');
  });

  it('cancels a download, and turning Copilot off cancels it too', async () => {
    const harness = setup({ runtime: 'downloadable' });
    await harness.controller.copilotUpdate(PRINCIPAL, currentConsent());
    await harness.controller.copilotRuntimeDownload();
    const cancelled = await harness.controller.copilotRuntimeDownloadCancel();
    await vi_waitFor(async () => expect((await harness.controller.copilotStatus()).runtime.state).toBe('missing'));
    expect(cancelled.enabled).toBe(true);

    await harness.controller.copilotRuntimeDownload();
    await harness.controller.copilotUpdate(PRINCIPAL, { enabled: false });
    expect((await harness.controller.copilotStatus()).runtime.state).toBe('missing');
  });

  it('signs in through the endpoints with the mock transport: challenge, wait, then signed in; sign-out returns to signed out', async () => {
    const { controller, transport } = setup({ signedIn: false, login: 'octocat' });
    transport.scriptSignIn({ challenge: { kind: 'browser', url: 'https://github.com/login/oauth/authorize?client_id=x' }, outcome: 'success', login: 'monalisa' });
    await controller.copilotUpdate(PRINCIPAL, currentConsent());
    expect(await controller.copilotStatus()).toMatchObject({ enabled: true, signedIn: false, login: null });

    await expect(controller.copilotSignInWait(openReply())).rejects.toMatchObject({ status: 409, response: { code: 'sign_in_not_started' } });
    const challenge = await controller.copilotSignIn();
    expect(challenge).toEqual({ kind: 'browser', url: 'https://github.com/login/oauth/authorize?client_id=x' });
    const done = await controller.copilotSignInWait(openReply());
    expect(done).toMatchObject({ enabled: true, signedIn: true, login: 'monalisa' });
    expect(done.models.map((m) => m.id)).toContain(GPT);
    expect(transport.signInCalls()).toMatchObject({ started: 1, waited: 1 });

    const out = await controller.copilotSignOut();
    expect(out).toMatchObject({ signedIn: false, login: null });
    expect(transport.signInCalls().signedOut).toBe(1);
  });

  it('answers a device-code challenge as the wire shape, and an expired sign-in as 409 AI_KEY_REQUIRED with its reason', async () => {
    const { controller, transport } = setup({ signedIn: false });
    await controller.copilotUpdate(PRINCIPAL, currentConsent());
    const device = { kind: 'device', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresAt: new Date(Date.now() + 60_000).toISOString() } as const;
    transport.scriptSignIn({ challenge: device, outcome: 'expired' });
    expect(await controller.copilotSignIn()).toEqual(device);
    await expect(controller.copilotSignInWait(openReply())).rejects.toMatchObject({
      status: 409,
      response: { code: 'AI_KEY_REQUIRED', details: { signInReason: 'sign_in_expired' } },
    });
    expect((await controller.copilotStatus()).signedIn).toBe(false);
  });

  it('cancels the runtime sign-in when the client hangs up on the wait', async () => {
    const { controller, transport } = setup({ signedIn: false });
    await controller.copilotUpdate(PRINCIPAL, currentConsent());
    transport.scriptSignIn({ outcome: 'pending' });
    await controller.copilotSignIn();
    const reply = openReply();
    const waiting = controller.copilotSignInWait(reply);
    await new Promise((resolve) => setTimeout(resolve, 10));
    (reply as unknown as { raw: EventEmitter }).raw.emit('close');
    await expect(waiting).rejects.toMatchObject({ response: { details: { signInReason: 'sign_in_cancelled' } } });
    expect(transport.signInCalls().aborted).toBe(1);
  });

  it('generates a note on Copilot with the selected model, and the other providers are never called', async () => {
    const { ai, transport } = setup({ signedIn: true });
    await ai.update({ openaiCompatible: { baseUrl: mock.baseUrl, model: 'mock-model', requiresKey: false } }, LOCAL_USER_ID);
    await ai.setKey('openai', PLANTED_KEY, LOCAL_USER_ID);
    await enableCopilot(ai, LOCAL_USER_ID, { model: CLAUDE });
    transport.queue({ kind: 'answer', text: '# Notes from Copilot\n' });

    expect(await collectText(ai)).toBe('# Notes from Copilot\n');
    const [session] = transport.sessions();
    expect(session?.config.model).toBe(CLAUDE);
    expect(session?.config.availableTools).toEqual([]);
    expect(session?.deleted).toBe(true);
    expect(mock.requests).toHaveLength(0);
    const target = await ai.port.resolveTask(CTX, 'notes.generate');
    expect(target).toMatchObject({ provider: 'copilot', model: CLAUDE });
  });

  it('holds a native-schema model to its schema and prompts a Claude model for it, per the catalog', async () => {
    const { ai, transport } = setup({ signedIn: true });
    await enableCopilot(ai, LOCAL_USER_ID, { model: GPT });
    const schema = z.object({ title: z.string() });
    const ask = async () => {
      const target = await ai.port.resolveTask({ ...CTX, feature: 'notes.title' }, 'notes.title');
      return ai.port.generateStructured({ ...CTX, feature: 'notes.title' }, { target, system: 'Title it.', user: 'Budget by Friday.', schema, schemaName: 'title' });
    };

    transport.queue({ kind: 'answer', text: '{"title":"Budget"}' });
    expect((await ask()).value).toEqual({ title: 'Budget' });
    expect(transport.sessions()[0]?.prompts[0]?.responseSchema).toBeDefined();

    await ai.updateCopilot({ model: CLAUDE }, LOCAL_USER_ID);
    transport.queue({ kind: 'answer', text: '{"title":"Budget"}' });
    expect((await ask()).value).toEqual({ title: 'Budget' });
    const prompted = transport.sessions()[1];
    expect(prompted?.config.model).toBe(CLAUDE);
    expect(prompted?.prompts[0]?.responseSchema).toBeUndefined();
    expect(prompted?.config.systemMessage.content).toContain('title');
  });

  it('routes Ask to Copilot with no OpenAI key, and keeps it there when one is saved: the key serves only search by meaning', async () => {
    const { ai, controller, transport } = setup({ signedIn: true });
    await enableCopilot(ai, LOCAL_USER_ID);
    const askCtx = { ...CTX, feature: 'ask.respond' };
    const searchCtx = { ...CTX, feature: 'search.embed' };

    // No OpenAI key: Ask is on Copilot, with tool calling, and nothing is reported missing.
    const status = await controller.copilotStatus();
    expect(status.unavailableTasks).toEqual([]);
    expect((await controller.state(PRINCIPAL)).unavailableTasks).toEqual([]);
    expect(await ai.port.capabilities(askCtx)).toMatchObject({ available: true, toolCalling: true });
    expect(await ai.port.resolveTask(askCtx, 'ask.respond')).toMatchObject({ provider: 'copilot', model: GPT });
    // Search by meaning waits for the OpenAI key (Copilot has no embeddings).
    expect(await ai.port.capabilities(searchCtx)).toMatchObject({ available: false, reason: 'ai_key_missing' });

    // An OpenAI key: Ask and notes stay on Copilot; the embeddings go to OpenAI.
    await ai.setKey('openai', PLANTED_KEY, LOCAL_USER_ID);
    expect((await controller.copilotStatus()).unavailableTasks).toEqual([]);
    expect(await ai.port.resolveTask(askCtx, 'ask.respond')).toMatchObject({ provider: 'copilot', model: GPT });
    expect(await ai.port.resolveTask(CTX, 'notes.generate')).toMatchObject({ provider: 'copilot' });
    expect(await ai.port.capabilities(searchCtx)).toMatchObject({ available: true });
    expect(await ai.port.resolveTask(searchCtx, 'search.embed')).toMatchObject({ provider: 'openai' });
    expect(transport.sessions()).toHaveLength(0);
    expect(mock.requests).toHaveLength(0);

    // Taking the key away leaves Ask where it was.
    await ai.deleteKey('openai', LOCAL_USER_ID);
    expect((await controller.copilotStatus()).unavailableTasks).toEqual([]);
    expect(await ai.port.resolveTask(askCtx, 'ask.respond')).toMatchObject({ provider: 'copilot' });
  });

  it('runs an Ask tool step on Copilot: the call ends the step, the held session takes the output, and the answer follows', async () => {
    const { ai, transport } = setup({ signedIn: true });
    await enableCopilot(ai, LOCAL_USER_ID);
    const askCtx = { ...CTX, feature: 'ask.respond' };
    const target = await ai.port.resolveTask(askCtx, 'ask.respond');
    const tools = [{ name: 'search', description: 'Searches the meetings.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } }];
    const history = [
      { role: 'system' as const, content: 'Answer from the tools.' },
      { role: 'user' as const, content: 'Who is Joe?' },
    ];
    const run = async (messages: Parameters<typeof ai.port.chat>[1]['messages']) => {
      const events = [];
      for await (const event of ai.port.chat(askCtx, { target, messages, tools, toolChoice: 'auto' })) events.push(event);
      return events;
    };

    transport.queue({ kind: 'toolCalls', calls: [{ name: 'search', arguments: { query: 'Joe' }, toolCallId: 'call-1' }] });
    transport.queue({ kind: 'answer', text: 'Joe sends the budget by Friday.' });
    const first = await run(history);
    expect(first.filter((event) => event.type === 'tool_call')).toEqual([{ type: 'tool_call', id: 'call-1', name: 'search', arguments: { query: 'Joe' } }]);
    expect(ai.copilot.providerAdapter?.bridge.heldSessions()).toBe(1);

    const second = await run([
      ...history,
      { role: 'assistant', content: null, toolCalls: [{ id: 'call-1', name: 'search', arguments: { query: 'Joe' } }] },
      { role: 'tool', toolCallId: 'call-1', content: '{"hits":["Joe: budget by Friday"]}' },
    ]);
    expect(second.flatMap((event) => (event.type === 'delta' ? [event.text] : [])).join('')).toBe('Joe sends the budget by Friday.');
    const sessions = transport.sessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ continuations: 1, deleted: true });
    expect(sessions[0]?.config.model).toBe(GPT);
    expect(sessions[0]?.toolRuns).toEqual([{ toolCallId: 'call-1', name: 'search', arguments: { query: 'Joe' }, output: '{"hits":["Joe: budget by Friday"]}' }]);
    expect(mock.requests).toHaveLength(0);
  });

  it('closes the sessions the tool bridge holds when Copilot stops (server shutdown)', async () => {
    const { ai, transport, calls } = setup({ signedIn: true });
    await enableCopilot(ai, LOCAL_USER_ID);
    const askCtx = { ...CTX, feature: 'ask.respond' };
    const target = await ai.port.resolveTask(askCtx, 'ask.respond');
    const tools = [{ name: 'search', description: 'Searches the meetings.', parameters: { type: 'object', properties: {}, additionalProperties: false } }];
    transport.queue({ kind: 'toolCalls', calls: [{ name: 'search', toolCallId: 'call-1' }] });
    for await (const _event of ai.port.chat(askCtx, { target, messages: [{ role: 'user', content: 'Who is Joe?' }], tools, toolChoice: 'auto' })) {
      // drain the step
    }
    const adapter = ai.copilot.providerAdapter;
    expect(adapter?.bridge.heldSessions()).toBe(1);
    expect(transport.sessions()[0]?.deleted).toBe(false);

    await ai.close();
    expect(adapter?.bridge.heldSessions()).toBe(0);
    expect(transport.sessions()[0]).toMatchObject({ deleted: true });
    expect(calls.stopped).toBe(1);
  });

  it('a Copilot model the live listing marks as tool-less: Ask falls back to the OpenAI slot (never the compatible server), else is reported unavailable', async () => {
    const toolless = [
      { id: GPT, name: 'GPT-5 mini', capabilities: { supports: { toolCalls: false } } },
      { id: CLAUDE, name: 'Claude Haiku 4.5' },
    ];
    const { ai, controller } = setup({ signedIn: true, models: toolless });
    await ai.update({ provider: 'openai-compatible', openaiCompatible: { baseUrl: mock.baseUrl, model: 'mock-model', requiresKey: false } }, LOCAL_USER_ID);
    const askCtx = { ...CTX, feature: 'ask.respond' };
    expect(await ai.port.resolveTask(askCtx, 'ask.respond')).toMatchObject({ provider: 'openai-compatible', model: 'mock-model' });

    await enableCopilot(ai, LOCAL_USER_ID, { model: GPT });
    expect((await controller.copilotStatus()).unavailableTasks).toEqual([{ task: 'ask.respond', reason: 'needs_tool_calling' }]);
    await expect(ai.port.resolveTask(askCtx, 'ask.respond')).rejects.toMatchObject({ errorClass: 'key_missing' });
    await ai.setKey('openai', PLANTED_KEY, LOCAL_USER_ID);
    expect((await controller.copilotStatus()).unavailableTasks).toEqual([]);
    expect(await ai.port.resolveTask(askCtx, 'ask.respond')).toMatchObject({ provider: 'openai', model: DEFAULT_DESKTOP_AI_SETTINGS.openai.model });
    expect(await ai.port.resolveTask(CTX, 'notes.generate')).toMatchObject({ provider: 'copilot', model: GPT });

    // A model that can call tools takes Ask back onto Copilot.
    await ai.updateCopilot({ model: CLAUDE }, LOCAL_USER_ID);
    expect(await ai.port.resolveTask(askCtx, 'ask.respond')).toMatchObject({ provider: 'copilot', model: CLAUDE });
    expect(mock.requests).toHaveLength(0);

    // Leaving Copilot: everything is the compatible server again, as before Copilot.
    await ai.update({ provider: 'openai-compatible' }, LOCAL_USER_ID);
    expect(await ai.port.resolveTask(askCtx, 'ask.respond')).toMatchObject({ provider: 'openai-compatible', model: 'mock-model' });
    expect(await ai.unavailableTasks()).toEqual([]);
  });

  it('with Copilot chosen and no OpenAI key, Copilot serves notes and Ask, and nothing is reported missing', async () => {
    const { ai, controller } = setup({ signedIn: true });
    await enableCopilot(ai, LOCAL_USER_ID);
    expect((await controller.copilotStatus()).unavailableTasks).toEqual([]);
    expect(await ai.port.capabilities(CTX)).toMatchObject({ available: true });
    expect(await ai.port.capabilities({ ...CTX, feature: 'ask.respond' })).toMatchObject({ available: true, toolCalling: true });
  });

  it('signed out: generating is refused as a missing key before anything is sent', async () => {
    const { ai, transport } = setup({ signedIn: false });
    await enableCopilot(ai, LOCAL_USER_ID);
    expect(await ai.port.capabilities(CTX)).toMatchObject({ available: false, reason: 'ai_key_missing' });
    await expect(collectText(ai)).rejects.toMatchObject({ errorClass: 'key_missing' });
    expect(transport.sessions()).toHaveLength(0);
  });

  it('allows the Copilot hosts only while Copilot is the provider, and api.openai.com with it only while an OpenAI key is stored', async () => {
    const { ai, guard, calls, controller } = setup();
    await ai.applyEgress();
    expect(guard.allowedHosts).toEqual(['api.openai.com']);

    // Copilot, no OpenAI key: the Copilot hosts alone.
    await enableCopilot(ai, LOCAL_USER_ID);
    expect(guard.allowedHosts).toEqual([...COPILOT_EGRESS_HOSTS]);
    expect(guard.isAllowed('api.openai.com')).toBe(false);
    expect((await controller.copilotStatus()).enabled).toBe(true);
    expect(ai.copilot.ready).toBe(true);

    // An OpenAI key added (and removed) while Copilot is the provider moves its host on (and off) at once.
    await ai.setKey('openai', PLANTED_KEY, LOCAL_USER_ID);
    expect(guard.allowedHosts).toEqual([...COPILOT_EGRESS_HOSTS, 'api.openai.com']);
    expect((await controller.copilotStatus()).allowedHosts).toEqual([...COPILOT_EGRESS_HOSTS, 'api.openai.com']);
    await ai.deleteKey('openai', LOCAL_USER_ID);
    expect(guard.allowedHosts).toEqual([...COPILOT_EGRESS_HOSTS]);
    await ai.setKey('openai', PLANTED_KEY, LOCAL_USER_ID);
    expect(guard.isAllowed('api.openai.com')).toBe(true);

    // Another provider: only its host, whatever Copilot's consent and the keys.
    await ai.update({ provider: 'openai' }, LOCAL_USER_ID);
    expect(guard.allowedHosts).toEqual(['api.openai.com']);
    for (const host of COPILOT_EGRESS_HOSTS) expect(guard.isAllowed(host)).toBe(false);
    expect(ai.copilot.ready).toBe(false);
    expect(calls.stopped).toBe(1);
    expect(await controller.copilotStatus()).toMatchObject({ enabled: false, models: [] });
    await expect(controller.copilotSignIn()).rejects.toMatchObject({ status: 409, response: { code: 'copilot_disabled' } });

    // An OpenAI key changing while another provider is chosen leaves the allowlist alone.
    await ai.update({ provider: 'openai-compatible', openaiCompatible: { baseUrl: 'https://llm.corp.example/v1', model: 'm' } }, LOCAL_USER_ID);
    await ai.deleteKey('openai', LOCAL_USER_ID);
    expect(guard.allowedHosts).toEqual(['llm.corp.example']);
  });

  it('explains a blocked OpenAI key test while Copilot is the provider and no key is saved yet', async () => {
    const harness = mockCopilotHost();
    const guard = new EgressGuard({ logError: (line) => logLines.push(line) });
    const ai = new DesktopAi({
      settings,
      secrets,
      adapters: providers.adapters,
      copilot: harness.host,
      onAllowedHosts: (hosts) => guard.allow(hosts),
      checkEgress: (host) => guard.check(host),
    });
    created.push(ai);
    await enableCopilot(ai, LOCAL_USER_ID);
    const result = await ai.testKey('openai', PLANTED_KEY);
    expect(result.success).toBe(false);
    expect(result.checks[0]?.detail).toMatch(/blocked the connection to api\.openai\.com.*Copilot.*Save the key/);
    expect(JSON.stringify(result)).not.toContain('PLANTEDkvox584');
  });

  it('removes the Copilot data only with Copilot off, and keeps the downloaded runtime unless asked', async () => {
    const { ai, controller, calls } = setup();
    await enableCopilot(ai, LOCAL_USER_ID);
    await expect(controller.copilotRemoveData()).rejects.toMatchObject({ status: 409, response: { code: 'copilot_enabled' } });
    expect(calls.removed).toEqual([]);

    await ai.updateCopilot({ enabled: false }, LOCAL_USER_ID);
    expect(await controller.copilotRemoveData()).toEqual({ removed: ['home', 'work'], keptRuntime: true });
    expect(await controller.copilotRemoveData('true')).toEqual({ removed: ['home', 'work'], keptRuntime: false });
    expect(calls.removed).toEqual([{ includeRuntime: false }, { includeRuntime: true }]);
  });

  it('brings Copilot back up at start when the stored settings have it on', async () => {
    const first = setup();
    await enableCopilot(first.ai, LOCAL_USER_ID);
    await first.ai.close();
    const second = setup({ signedIn: true });
    expect(second.ai.copilot.ready).toBe(false);
    await second.ai.start();
    expect(second.ai.copilot.ready).toBe(true);
    expect(second.calls.transports).toBe(1);
  });

  it('shows the allowed hosts in every status response', async () => {
    const { controller } = setup();
    expect((await controller.copilotStatus()).allowedHosts).toEqual(['api.openai.com']);
    const on = await controller.copilotUpdate(PRINCIPAL, currentConsent());
    expect(on.allowedHosts).toEqual(expect.arrayContaining([...COPILOT_EGRESS_HOSTS]));
  });

  it('keeps every token out of responses, errors, logs and files', async () => {
    const { ai, controller, transport } = setup({ signedIn: true });
    await enableCopilot(ai, LOCAL_USER_ID);
    // The runtime fails with a message that carries tokens.
    transport.queue({ kind: 'sessionError', errorType: 'authentication', statusCode: 401, message: `bad credentials ${TOKENS.join(' ')} Bearer abc.def.ghi` });
    const failure = (await collectText(ai).catch((e: unknown) => e)) as Error;
    transport.scriptSignIn({ startError: new Error(`cannot start ${TOKENS[0]} Authorization: Bearer abc.def.ghi`) });
    const signInFailure = (await controller.copilotSignIn().catch((e: unknown) => e)) as Error & { getResponse(): unknown };
    transport.setSignedIn(true);

    const surfaces: Record<string, string> = {
      error: `${failure.name}: ${failure.message} ${JSON.stringify(failure)} ${failure.stack ?? ''}`,
      signInError: `${signInFailure.message} ${JSON.stringify(signInFailure.getResponse?.() ?? {})}`,
      status: JSON.stringify(await controller.copilotStatus()),
      settingsView: JSON.stringify(await controller.settings()),
      notesState: JSON.stringify(await controller.state(PRINCIPAL)),
      settingsRows: JSON.stringify(await db.prisma.$queryRaw(Prisma.sql`SELECT * FROM system_settings`)),
      logs: logLines.join('\n'),
    };
    for (const [surface, text] of Object.entries(surfaces)) {
      for (const token of TOKENS) expect(text, surface).not.toContain(token);
      expect(text, surface).not.toMatch(/gho_|ghu_|github_pat_|Bearer /);
    }
    for (const file of readdirSync(db.userDataDir)) expect(file).not.toMatch(/token/i);
  });
});

/** Polls an assertion for a moment (a background download settling). */
async function vi_waitFor(check: () => Promise<void>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
