import { EventEmitter } from 'node:events';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { Prisma } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createScriptedRuntime, describeKvoxAiConformance, type KvoxAiConformanceProvider } from '@marinoscar/kvox-ai/testing';
import type { KvoxAiContext } from '@marinoscar/kvox-api/ports';
import { COPILOT_EGRESS_HOSTS } from '@marinoscar/kvox-ai/copilot';
import type { AiProviderAdapter } from '@marinoscar/platform-ai-providers';

import { COPILOT_CONSENT_VERSION } from '../../src/server/ai/copilot-contract';
import type { CopilotHost } from '../../src/server/ai/copilot-host';
import {
  AI_KEY_PURPOSE,
  DEFAULT_DESKTOP_AI_SETTINGS,
  DESKTOP_AI_NAMESPACE,
  DESKTOP_AI_PROVIDERS,
  DESKTOP_AI_SETTINGS_NAMESPACE,
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
//   5. COPILOT IS AN OPT-IN ADD-ON (marinoscar/kvox-desktop#21): off by default and
//      then not even loaded, never switched on without consent, routed by
//      capability (notes on Copilot, Ask on OpenAI or reported unavailable),
//      signed in through the endpoints, and holding no token anywhere.
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

    await ai.update({ provider: null }, LOCAL_USER_ID);
    expect(guard.allowedHosts).toEqual([]);
    expect(guard.isAllowed('llm.corp.example')).toBe(false);
    expect(guard.isAllowed('127.0.0.1')).toBe(true);

    await ai.update({ provider: 'openai' }, LOCAL_USER_ID);
    expect(guard.allowedHosts).toEqual(['api.openai.com']);
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

// ---- 5. The Copilot add-on ---------------------------------------------------------

const CLAUDE = 'claude-haiku-4.5';
const GPT = 'gpt-5-mini';
const TOKENS = ['gho_PLANTEDcopilot0123456789abcdef', 'ghu_PLANTEDcopilot0123456789abcdef', 'github_pat_PLANTEDcopilot0123456789'];
const PRINCIPAL = { userId: LOCAL_USER_ID, orgId: null } as never;

/** A `reply` whose connection stays open until the answer is written (what the wait route reads). */
function openReply() {
  return { raw: Object.assign(new EventEmitter(), { writableFinished: false }) } as never;
}

describe('GitHub Copilot add-on', () => {
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

  it('is a selectable-by-consent slot, never the primary provider, and holds no key', async () => {
    const { ai, controller } = setup();
    const view = await controller.settings();
    expect(view.providers.map((p) => p.id)).toEqual(['openai', 'openai-compatible', 'copilot']);
    expect(view.providers.find((p) => p.id === 'copilot')).toMatchObject({ implemented: true, toolCalling: false, key: null, needsKey: false });
    expect(DESKTOP_AI_PROVIDERS.find((p) => p.id === 'copilot')).toMatchObject({ implemented: true, toolCalling: false });

    // It is an add-on: it cannot be the primary provider, and it has no API key to store.
    await expect(ai.update({ provider: 'copilot' }, LOCAL_USER_ID)).rejects.toMatchObject({ status: 400 });
    await expect(ai.setKey('copilot', 'gho_abcdefghijklmnop', LOCAL_USER_ID)).rejects.toMatchObject({
      status: 400,
      response: { code: 'ai_key_not_applicable' },
    });
    expect((await ai.read()).provider).toBe('openai');
  });

  it('migrates a stored pre-Copilot setting to the defaults and never turns Copilot on', async () => {
    const legacy = { ...DEFAULT_DESKTOP_AI_SETTINGS, copilot: { enabled: false } };
    await db.prisma.systemSettings.upsert({
      where: { key: DESKTOP_AI_NAMESPACE },
      update: { value: legacy },
      create: { key: DESKTOP_AI_NAMESPACE, value: legacy, version: 1, updatedByUserId: LOCAL_USER_ID },
    });
    const { ai, controller, calls } = setup();
    expect((await ai.read()).copilot).toEqual({ enabled: false, consentedAt: null, consentVersion: null, model: null });
    await ai.start();
    expect(calls.prepared).toBe(0);
    expect(await controller.copilotStatus()).toMatchObject({ enabled: false, signedIn: false, models: [], unavailableTasks: [] });


    // A row with no copilot key at all reads the same.
    const bare = { provider: 'openai', openai: { model: 'gpt-5.4-mini' }, openaiCompatible: DEFAULT_DESKTOP_AI_SETTINGS.openaiCompatible };
    await db.prisma.systemSettings.update({ where: { key: DESKTOP_AI_NAMESPACE }, data: { value: bare } });
    expect((await ai.read()).copilot).toEqual(DEFAULT_DESKTOP_AI_SETTINGS.copilot);
  });

  it('loads nothing while Copilot is off: no adapter, no runtime, no SDK, no Copilot host in the egress list', async () => {
    const { ai, controller, calls, guard } = setup();
    await ai.start();
    await ai.applyEgress();
    expect(ai.copilot.ready).toBe(false);
    expect(providers.adapters.copilot).toBeUndefined();
    expect(calls).toEqual({ prepared: 0, downloads: 0, transports: 0, stopped: 0 });
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
    await expect(controller.copilotUpdate(PRINCIPAL, { enabled: 'yes' })).rejects.toMatchObject({ status: 400 });
    expect((await ai.read()).copilot.enabled).toBe(false);
    expect(calls.prepared).toBe(0);

    const status = await controller.copilotUpdate(PRINCIPAL, currentConsent());
    expect(status).toMatchObject({ enabled: true, runtime: { state: 'ready', version: '1.0.98' } });
    expect(calls.prepared).toBe(1);
    expect(calls.transports).toBe(1);
    expect(providers.adapters.copilot).toBeUndefined(); // the runtime's map is the instance's own copy
  });

  it('asks again when the consent text changes: an older consent version is off', async () => {
    const { ai, controller, calls } = setup();
    await ai.updateCopilot(currentConsent(), LOCAL_USER_ID);
    // A newer text: the stored consent no longer matches.
    await settings.patchSystem(DESKTOP_AI_NAMESPACE, { copilot: { consentVersion: '0-older' } }, { actorUserId: LOCAL_USER_ID });
    expect(await controller.copilotStatus()).toMatchObject({ enabled: false });
    await ai.start();
    expect(ai.copilot.ready).toBe(false);
    expect(calls.stopped).toBeGreaterThan(0);
  });

  it('reports a missing runtime as a state, and refuses sign-in and download politely', async () => {
    const { ai, controller } = setup({ runtime: 'missing' });
    const status = await controller.copilotUpdate(PRINCIPAL, currentConsent());
    expect(status).toMatchObject({ enabled: true, signedIn: false, runtime: { state: 'missing', version: null, progress: null } });
    await expect(controller.copilotSignIn()).rejects.toMatchObject({ status: 409, response: { code: 'runtime_not_ready' } });
    await expect(controller.copilotRuntimeDownload()).rejects.toMatchObject({ status: 409, response: { code: 'runtime_download_unavailable' } });
    // Generating is refused as "not configured": there is no Copilot to send to, and nothing is sent anywhere.
    await expect(collectText(ai)).rejects.toMatchObject({ errorClass: 'not_configured' });
  });

  it('downloads the runtime on request, with progress in the status, then is ready', async () => {
    const harness = setup({ runtime: 'downloadable' });
    const { controller } = harness;
    await controller.copilotUpdate(PRINCIPAL, currentConsent());
    expect((await controller.copilotStatus()).runtime.state).toBe('missing');
    expect(harness.calls.downloads).toBe(0); // never without the user's action

    const started = await controller.copilotRuntimeDownload();
    expect(started.runtime).toMatchObject({ state: 'downloading', progress: 0 });
    harness.progress(25, 100);
    expect((await controller.copilotStatus()).runtime).toMatchObject({ state: 'downloading', progress: 0.25 });
    harness.finishDownload();
    await vi_waitFor(async () => expect((await controller.copilotStatus()).runtime.state).toBe('ready'));
    expect(harness.calls.downloads).toBe(1);

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

  it('generates a note on Copilot with the selected model, and the OpenAI side is never called', async () => {
    const { ai, transport } = setup({ signedIn: true });
    await ai.update({ provider: 'openai-compatible', openaiCompatible: { baseUrl: mock.baseUrl, model: 'mock-model', requiresKey: false } }, LOCAL_USER_ID);
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

  it('routes Ask to OpenAI when its key is saved, and reports it unavailable (needs_tool_calling) when it is not', async () => {
    const { ai, controller, transport } = setup({ signedIn: true });
    await enableCopilot(ai, LOCAL_USER_ID);
    const askCtx = { ...CTX, feature: 'ask.respond' };

    // No OpenAI key: Ask is listed, with the reason, and refused as a missing key.
    const status = await controller.copilotStatus();
    expect(status.unavailableTasks).toEqual([{ task: 'ask.respond', reason: 'needs_tool_calling' }]);
    expect((await controller.state(PRINCIPAL)).unavailableTasks).toEqual(status.unavailableTasks);
    expect(await ai.port.capabilities(askCtx)).toMatchObject({ available: false, reason: 'ai_key_missing' });
    await expect(ai.port.resolveTask(askCtx, 'ask.respond')).rejects.toMatchObject({ errorClass: 'key_missing' });

    // An OpenAI key: Ask goes to OpenAI, notes stay on Copilot.
    await ai.setKey('openai', PLANTED_KEY, LOCAL_USER_ID);
    expect((await controller.copilotStatus()).unavailableTasks).toEqual([]);
    expect(await ai.port.resolveTask(askCtx, 'ask.respond')).toMatchObject({ provider: 'openai' });
    expect(await ai.port.capabilities(askCtx)).toMatchObject({ available: true, toolCalling: true });
    expect(await ai.port.resolveTask(CTX, 'notes.generate')).toMatchObject({ provider: 'copilot' });
    expect(transport.sessions()).toHaveLength(0);
  });

  it('with AI off as the primary provider, Copilot serves notes and Ask is not offered', async () => {
    const { ai, controller } = setup({ signedIn: true });
    await ai.update({ provider: null }, LOCAL_USER_ID);
    await enableCopilot(ai, LOCAL_USER_ID);
    expect((await controller.copilotStatus()).unavailableTasks.map((t) => t.task)).toEqual(['ask.respond']);
    expect(await ai.port.capabilities(CTX)).toMatchObject({ available: true });
    expect((await ai.port.capabilities({ ...CTX, feature: 'ask.respond' })).toolCalling).toBe(false);
  });

  it('signed out: generating is refused as a missing key before anything is sent', async () => {
    const { ai, transport } = setup({ signedIn: false });
    await enableCopilot(ai, LOCAL_USER_ID);
    expect(await ai.port.capabilities(CTX)).toMatchObject({ available: false, reason: 'ai_key_missing' });
    await expect(collectText(ai)).rejects.toMatchObject({ errorClass: 'key_missing' });
    expect(transport.sessions()).toHaveLength(0);
  });

  it('adds the Copilot hosts to the egress allowlist only while Copilot is on, and takes the adapter down when it is off', async () => {
    const { ai, guard, calls, controller } = setup();
    await ai.applyEgress();
    expect(guard.allowedHosts).toEqual(['api.openai.com']);

    await enableCopilot(ai, LOCAL_USER_ID);
    expect(guard.allowedHosts).toEqual(['api.openai.com', ...COPILOT_EGRESS_HOSTS]);
    expect((await controller.copilotStatus()).enabled).toBe(true);
    expect(ai.copilot.ready).toBe(true);

    await ai.updateCopilot({ enabled: false }, LOCAL_USER_ID);
    expect(guard.allowedHosts).toEqual(['api.openai.com']);
    for (const host of COPILOT_EGRESS_HOSTS) expect(guard.isAllowed(host)).toBe(false);
    expect(ai.copilot.ready).toBe(false);
    expect(calls.stopped).toBe(1);
    expect(await controller.copilotStatus()).toMatchObject({ enabled: false, models: [] });
    await expect(controller.copilotSignIn()).rejects.toMatchObject({ status: 409, response: { code: 'copilot_disabled' } });
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
