import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createScriptedRuntime, describeKvoxAiConformance, type KvoxAiConformanceProvider } from '@marinoscar/kvox-ai/testing';
import type { KvoxAiContext } from '@marinoscar/kvox-api/ports';
import type { AiProviderAdapter } from '@marinoscar/platform-ai-providers';

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
//   5. COPILOT IS A DISABLED SLOT: shown, not selectable, toolCalling=false.
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
    schema: z.object({ maxInputTokens: z.number().nullable(), maxOutputTokens: z.number().nullable(), maxDocumentBytes: z.number() }),
    defaults: { maxInputTokens: null, maxOutputTokens: null, maxDocumentBytes: 10 * 1024 * 1024 },
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

function desktopAi(adapters: Readonly<Record<string, AiProviderAdapter>>, extra: { requestTimeoutMs?: number; hosts?: string[][] } = {}): DesktopAi {
  return new DesktopAi({
    settings,
    secrets,
    adapters,
    onAllowedHosts: (hosts) => {
      extra.hosts?.push(hosts);
      logLines.push(`server: egress allowlist is loopback and ${hosts.join(', ')}`);
    },
    ...(extra.requestTimeoutMs !== undefined ? { requestTimeoutMs: extra.requestTimeoutMs } : {}),
  });
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

  it('shows Copilot as a disabled slot with toolCalling=false, and refuses to select it or store its key', async () => {
    const ai = desktopAi(providers.adapters);
    const egress = new EgressGuard({ logError: () => undefined });
    const view = await new DesktopAiController(ai.port, ai, egress).settings();
    expect(view.providers.map((p) => p.id)).toEqual(['openai', 'openai-compatible', 'copilot']);
    expect(view.providers.find((p) => p.id === 'copilot')).toMatchObject({ implemented: false, toolCalling: false, key: null, needsKey: false });
    expect(DESKTOP_AI_PROVIDERS.find((p) => p.id === 'copilot')).toMatchObject({ implemented: false, toolCalling: false });

    await expect(ai.update({ provider: 'copilot' }, LOCAL_USER_ID)).rejects.toMatchObject({ status: 400 });
    await expect(ai.update({ copilot: { enabled: true } }, LOCAL_USER_ID)).rejects.toMatchObject({ status: 400 });
    await expect(ai.setKey('copilot', 'gho_abcdefghijklmnop', LOCAL_USER_ID)).rejects.toMatchObject({
      status: 400,
      response: { code: 'ai_provider_unavailable' },
    });
    expect((await ai.read()).provider).toBe('openai');
    expect(await providers.adapters.copilot).toBeUndefined();
  });
});
