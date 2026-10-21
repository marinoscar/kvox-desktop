import { randomBytes, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { KVOX_LOCAL_EMBEDDING } from '@marinoscar/kvox-ai';
import { createLocalEmbedder, type LocalEmbedder } from '@marinoscar/kvox-ai/local-embeddings';

import { importLocalFile } from '../../src/main/import-file';
import { startServer, type RunningServer } from '../../src/server/bootstrap';
import { spawnNodeScript } from '../../src/server/database';
import type { DesktopConnection } from '../../src/shared/protocol';
import { ROOT, fakeCipher, removeQuietly } from './support/database';

// =============================================================================
// On-device semantic search, end to end, with the REAL model (marinoscar/kvox#660)
// =============================================================================
//
// The Desktop server as bootstrap.ts starts it (PGlite, every slice, the job loop)
// with the bge-small model already installed under <userData>/models, and an embed
// transport that runs `createLocalEmbedder` IN THIS PROCESS (the app runs it in a
// utility process of its own, which vitest cannot fork). It then:
//
//   1. imports two notes (no AI key anywhere), and shows that a paraphrase of the
//      first finds nothing: no shared words, no key, no embeddings;
//   2. gives the consent (the download endpoint, which only switches the installed
//      model on), lets the backfill index both notes, and shows the SAME paraphrase
//      now returns the right note first, `semantic: true`;
//   3. switches it off: back to full text only.
//
// Needs the model: set KVOX_LOCAL_MODEL_DIR to a models folder that holds
// `bge-small-en-v1.5-int8/` (what `downloadLocalEmbeddingModel` installs). Without
// it the suite is skipped. Needs `npm run prepare:db` like the other server tests.
// =============================================================================

const MODEL_DIR = process.env.KVOX_LOCAL_MODEL_DIR;
const TOKEN = randomBytes(32).toString('base64url');

/** A note file in KVox's own export format (the import route's input). */
function noteFile(title: string, body: string): string {
  return [
    '---',
    'schema: "kvox.note/v1"',
    `title: "${title}"`,
    'bodyFormat: "markdown"',
    `noteId: "${randomUUID()}"`,
    'version: 1',
    'versionSavedAt: "2026-03-04T16:00:00.000Z"',
    'exportedAt: "2026-03-05T09:30:00.000Z"',
    '---',
    '',
    `# ${title}`,
    '',
    body,
    '',
  ].join('\n');
}

describe.skipIf(!MODEL_DIR || !existsSync(join(MODEL_DIR, KVOX_LOCAL_EMBEDDING.model)))('on-device semantic search with the real model', () => {
  let userDataDir: string;
  let server: RunningServer;
  let connection: DesktopConnection;
  let embedder: LocalEmbedder | undefined;
  const logged: string[] = [];
  const embedCalls: number[] = [];

  async function api<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
    const response = await fetch(`${connection.baseUrl}/api${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${TOKEN}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    });
    const text = await response.text();
    const parsed = (text ? JSON.parse(text) : {}) as { data?: T };
    return { status: response.status, body: (parsed.data ?? parsed) as T };
  }

  async function importNote(title: string, body: string): Promise<string> {
    const file = join(userDataDir, `${randomUUID()}.md`);
    writeFileSync(file, noteFile(title, body));
    const outcome = await importLocalFile(file, { connection, log: (line) => logged.push(line) });
    expect(outcome).toMatchObject({ ok: true, kind: 'note' });
    if (!outcome.ok) throw new Error(outcome.message);
    return outcome.id;
  }

  beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'kvox-local-search-'));
    // The model is "already downloaded": the installed layout, copied.
    mkdirSync(join(userDataDir, 'models'), { recursive: true });
    cpSync(join(MODEL_DIR!, KVOX_LOCAL_EMBEDDING.model), join(userDataDir, 'models', KVOX_LOCAL_EMBEDDING.model), { recursive: true });
    server = await startServer({
      appRoot: ROOT,
      userDataDir,
      runNodeScript: spawnNodeScript(process.execPath),
      token: TOKEN,
      allowedOrigins: ['kvox://app'],
      log: (line) => logged.push(line),
      appVersion: '0.0.0-test',
      cipher: fakeCipher(),
      showNotification: () => undefined,
      requestRestart: () => undefined,
      // The utility process's job, in this process.
      embed: async (modelPath, texts) => {
        embedder ??= await createLocalEmbedder({ modelPath, numThreads: 1 });
        embedCalls.push(texts.length);
        return embedder.embed(texts);
      },
    });
    connection = { baseUrl: `http://127.0.0.1:${server.port}`, token: TOKEN, userId: server.userId, permissions: [...server.permissions] };
  }, 120_000);

  afterAll(async () => {
    await server?.close().catch(() => undefined);
    await embedder?.dispose().catch(() => undefined);
    removeQuietly(userDataDir);
  });

  it('finds a paraphrase with no API key, offline, once local search is on', async () => {
    const budget = await importNote('Finance sync', 'The finance team approved the quarterly budget, and the vendor invoice will be paid before the end of the month.');
    const garden = await importNote('Garden chores', 'Water the tomato plants every morning and prune the roses on Saturday.');
    // No shared word with the first note (no full-text hit), and no key for OpenAI's embeddings.
    const paraphrase = encodeURIComponent('accountants signed off on the spending plan');

    expect((await api<{ localSearch: unknown }>('/desktop/ai/settings')).body).toMatchObject({ settings: { localSearch: { enabled: false } } });
    const before = await api<{ results: Array<{ id: string }>; semantic: boolean }>(`/search?q=${paraphrase}`);
    expect(before.status).toBe(200);
    expect(before.body.semantic).toBe(false);
    expect(before.body.results).toEqual([]);

    // The model is installed: the status says so, with nothing switched on yet.
    const idle = await api<{ enabled: boolean; state: string; active: boolean }>('/desktop/ai/local-search');
    expect(idle.body).toMatchObject({ enabled: false, state: 'ready', active: false });
    expect((await api('/desktop/ai/local-search', { method: 'PATCH', body: JSON.stringify({ enabled: true }) })).status).toBe(409);

    // The consent action. The model is there already, so it only switches the feature on and asks for indexing.
    const consent = await api<{ enabled: boolean; active: boolean; consentedAt: string }>('/desktop/ai/local-search/download', { method: 'POST', body: JSON.stringify({ consent: true }) });
    expect(consent.status).toBe(202);
    expect(consent.body).toMatchObject({ enabled: true, active: true });

    // The backfill indexes both notes (the job loop runs them, the model embeds their chunks).
    let status: { types: Array<{ type: string; indexed: number; total: number }>; available: boolean; model: string | null } | undefined;
    for (let attempt = 0; attempt < 240; attempt += 1) {
      status = (await api<NonNullable<typeof status>>('/search/index-status')).body;
      const notes = status.types.find((entry) => entry.type === 'note');
      if (notes && notes.total >= 2 && notes.indexed >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(status).toMatchObject({ available: true, model: KVOX_LOCAL_EMBEDDING.model });
    expect(status?.types.find((entry) => entry.type === 'note')).toMatchObject({ indexed: 2, total: 2 });
    expect(embedCalls.length).toBeGreaterThan(0);

    const after = await api<{ results: Array<{ id: string; title: string }>; semantic: boolean }>(`/search?q=${paraphrase}`);
    expect(after.status).toBe(200);
    expect(after.body.semantic).toBe(true);
    expect(after.body.results[0]?.id).toBe(budget);
    expect(after.body.results.map((result) => result.id)).not.toContain(garden);

    // Off again: full text only, as before.
    const off = await api<{ enabled: boolean; active: boolean }>('/desktop/ai/local-search', { method: 'PATCH', body: JSON.stringify({ enabled: false }) });
    expect(off.body).toMatchObject({ enabled: false, active: false });
    const finished = await api<{ results: unknown[]; semantic: boolean }>(`/search?q=${paraphrase}`);
    expect(finished.body.semantic).toBe(false);
    expect(finished.body.results).toEqual([]);
    // Nothing left this machine: the guard blocked no connection.
    expect(logged.filter((line) => /egress blocked/i.test(line))).toEqual([]);
  }, 240_000);
});
