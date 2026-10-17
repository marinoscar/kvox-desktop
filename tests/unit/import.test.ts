import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { importLocalFile } from '../../src/main/import-file';
import { startServer, type RunningServer } from '../../src/server/bootstrap';
import type { DesktopConnection, ImportOutcome } from '../../src/shared/protocol';
import { ROOT, fakeCipher, removeQuietly } from './support/database';

// =============================================================================
// Importing files into the real local server (marinoscar/kvox#585)
// =============================================================================
//
// The Desktop server as `bootstrap.ts` starts it (PGlite, the vault, every
// slice), and the main process's `importLocalFile` against it, once per input
// kind, with the synthetic fixtures of tests/fixtures/import:
//
//   - a PDF transcript and a Markdown file become note source documents whose
//     text is extracted (the job runner reads them);
//   - a `kvox.transcript/v1` JSON keeps its named speakers and `recordedAt`;
//   - a note exported from KVox web imports with the same title and body, and
//     exports back to them (round trip);
//   - a foreign JSON, a binary file and a file over the limit are refused with
//     the slice's own sentence, before anything is created;
//   - nothing leaves 127.0.0.1 (the server's egress guard counts nothing).
//
// The route choice is the contract's (`detectKvoxImport`); nothing here parses.
// =============================================================================

const FIXTURES = join(ROOT, 'tests', 'fixtures', 'import');
const TOKEN = randomBytes(32).toString('base64url');

let userDataDir: string;
let server: RunningServer;
let connection: DesktopConnection;
const logged: string[] = [];

async function api<T>(path: string): Promise<T> {
  const response = await fetch(`${connection.baseUrl}/api${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  expect(response.status, path).toBe(200);
  const body = (await response.json()) as { data?: T } & T;
  return (body.data ?? body) as T;
}

async function importFixture(name: string): Promise<ImportOutcome> {
  return importLocalFile(join(FIXTURES, name), { connection, log: (line) => logged.push(line) });
}

async function waitForExtraction(objectId: string): Promise<{ status: string; characters?: number }> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const object = await api<{ metadata?: { noteSourceExtraction?: { status: string; characters?: number } } }>(`/storage/objects/${objectId}`);
    const extraction = object.metadata?.noteSourceExtraction;
    if (extraction && extraction.status !== 'extracting') return extraction;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`extraction of ${objectId} did not finish`);
}

beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'kvox-import-'));
  server = await startServer({
    appRoot: ROOT,
    userDataDir,
    nodeExecutable: process.execPath,
    token: TOKEN,
    allowedOrigins: ['kvox://app'],
    log: (line) => logged.push(line),
    appVersion: '0.0.0-test',
    cipher: fakeCipher(),
    showNotification: () => undefined,
    requestRestart: () => undefined,
  });
  connection = { baseUrl: `http://127.0.0.1:${server.port}`, token: TOKEN, userId: server.userId, permissions: [...server.permissions] };
});

afterAll(async () => {
  await server?.close().catch(() => undefined);
  removeQuietly(userDataDir);
});

describe('importLocalFile against the Desktop server', () => {
  it('imports a PDF transcript as a note source and reads its text', async () => {
    const outcome = await importFixture('roadmap-sync-transcript.pdf');

    expect(outcome).toMatchObject({ ok: true, kind: 'document', title: 'roadmap-sync-transcript.pdf' });
    if (!outcome.ok) return;
    const extraction = await waitForExtraction(outcome.id);
    expect(extraction.status).toBe('extracted');
    expect(extraction.characters).toBeGreaterThan(100);
  });

  it('imports Markdown and text as a note source', async () => {
    const outcome = await importFixture('standup.md');

    expect(outcome).toMatchObject({ ok: true, kind: 'document' });
    if (!outcome.ok) return;
    expect((await waitForExtraction(outcome.id)).status).toBe('extracted');
  });

  it('imports a transcript JSON with its named speakers and its recording date', async () => {
    const outcome = await importFixture('m03-roadmap-sync.transcript.json');

    expect(outcome).toMatchObject({ ok: true, kind: 'transcript', title: 'M03 roadmap sync' });
    if (!outcome.ok) return;
    const transcript = await api<{
      status: string;
      recordedAt: string;
      hasAudio: boolean;
      speakers: Array<{ displayName: string }>;
    }>(`/transcripts/${outcome.id}`);
    expect(transcript.status).toBe('ready');
    expect(transcript.hasAudio).toBe(false);
    expect(new Date(transcript.recordedAt).toISOString()).toBe('2026-03-04T15:00:00.000Z');
    expect(transcript.speakers.map((speaker) => speaker.displayName)).toEqual(['Dana Example', 'Lee Ortiz', 'Speaker C']);
  });

  it('imports a note exported from KVox web with the same title and body, and exports it back', async () => {
    const expected = JSON.parse(readFileSync(join(FIXTURES, 'planning-sync-note.expected.json'), 'utf8')) as { title: string; body: string };

    const outcome = await importFixture('planning-sync-note.md');

    expect(outcome).toMatchObject({ ok: true, kind: 'note', title: expected.title });
    if (!outcome.ok) return;
    const note = await api<{ title: string; body: string; status: string; currentVersion: number }>(`/notes/${outcome.id}`);
    expect(note).toMatchObject({ title: expected.title, body: expected.body, status: 'ready', currentVersion: 1 });

    // Round trip: the Desktop export of the imported note imports to the same note again.
    const exportDir = mkdtempSync(join(tmpdir(), 'kvox-import-export-'));
    try {
      const created = await fetch(`${connection.baseUrl}/api/notes/${outcome.id}/exports`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'markdown' }),
      });
      expect([200, 202]).toContain(created.status);
      // The Desktop server answers without the web edition's `{ data }` envelope.
      const createdBody = (await created.json()) as { exportId?: string; id?: string };
      const exportId = createdBody.exportId ?? createdBody.id;
      expect(exportId).toBeDefined();
      let url: string | undefined;
      for (let attempt = 0; attempt < 120 && !url; attempt += 1) {
        const download = await fetch(`${connection.baseUrl}/api/notes/exports/${exportId}/download`, { headers: { Authorization: `Bearer ${TOKEN}` } });
        if (download.status === 200) url = ((await download.json()) as { url: string }).url;
        else await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(url).toBeDefined();
      const file = await fetch(url!.startsWith('http') ? url! : `${connection.baseUrl}${url}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      const reexported = join(exportDir, 'again.md');
      writeFileSync(reexported, Buffer.from(await file.arrayBuffer()));
      const again = await importLocalFile(reexported, { connection });
      expect(again).toMatchObject({ ok: true, kind: 'note', title: expected.title });
      if (again.ok) expect((await api<{ body: string }>(`/notes/${again.id}`)).body).toBe(expected.body);
    } finally {
      removeQuietly(exportDir);
    }
  });

  it('relays the slice’s own refusal for a foreign JSON file, creating nothing', async () => {
    const before = await api<{ items: unknown[] }>('/transcripts?limit=100');
    const outcome = await importFixture('foreign.json');

    expect(outcome).toMatchObject({ ok: false, status: 400, reason: 'unsupported_schema' });
    if (outcome.ok) return;
    expect(outcome.message.length).toBeGreaterThan(10);
    expect((await api<{ items: unknown[] }>('/transcripts?limit=100')).items).toHaveLength(before.items.length);
  });

  it('refuses a binary file (audio has no transcription in Desktop) with the accepted types', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kvox-import-bin-'));
    try {
      const audio = join(dir, 'meeting.mp3');
      writeFileSync(audio, Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
      const outcome = await importLocalFile(audio, { connection });

      expect(outcome).toMatchObject({ ok: false, status: 400 });
      if (!outcome.ok) expect(outcome.message).toMatch(/Accepted types/);
    } finally {
      removeQuietly(dir);
    }
  });

  it('refuses a note file over the slice’s limit before it is stored', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kvox-import-big-'));
    try {
      const big = join(dir, 'big-note.md');
      const front = '---\nschema: "kvox.note/v1"\ntitle: "Big"\n---\n\n';
      writeFileSync(big, front + 'x'.repeat(5 * 1024 * 1024 + 10));
      const notesBefore = await api<{ items: unknown[] }>('/notes?limit=100');

      const outcome = await importLocalFile(big, { connection });

      expect(outcome).toMatchObject({ ok: false });
      if (!outcome.ok) expect(outcome.message).toMatch(/at most|larger than/);
      expect((await api<{ items: unknown[] }>('/notes?limit=100')).items).toHaveLength(notesBefore.items.length);
    } finally {
      removeQuietly(dir);
    }
  });

  it('refuses a path that is not a file', async () => {
    expect(await importLocalFile(FIXTURES, { connection })).toMatchObject({ ok: false });
    expect(await importLocalFile('relative/path.md', { connection })).toMatchObject({ ok: false });
  });

  it('sent nothing anywhere but 127.0.0.1, and logged no file name', () => {
    expect(server.egress.blocked).toBe(0);
    expect(logged.filter((line) => line.includes('egress blocked'))).toEqual([]);
    const importLines = logged.filter((line) => line.startsWith('import:'));
    expect(importLines.length).toBeGreaterThan(0);
    expect(importLines.join('\n')).not.toMatch(/roadmap|planning|standup|m03|foreign/i);
  });
});
