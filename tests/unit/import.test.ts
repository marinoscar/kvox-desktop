import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { importLocalFile, importLocalFiles } from '../../src/main/import-file';
import { startServer, type RunningServer } from '../../src/server/bootstrap';
import { spawnNodeScript } from '../../src/server/database';
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
//   - note documents (a PDF transcript, Markdown, text) go into ONE ad-hoc
//     import batch (marinoscar/kvox-desktop#47) and each becomes a note (the
//     batch's job reads them); a drop that mixes kinds still sends the
//     transcript JSON to its own route;
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

interface BatchItem {
  filename: string;
  path: string | null;
  status: string;
  noteId: string | null;
  failureMessage: string | null;
}

/** The items of an import batch once none is queued or importing (the notes slice's own routes). */
async function waitForBatch(batchId: string): Promise<BatchItem[]> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const { items } = await api<{ items: BatchItem[] }>(`/notes/import-batches/${batchId}/items?limit=200`);
    if (items.length > 0 && items.every((item) => item.status !== 'queued' && item.status !== 'importing')) return items;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`batch ${batchId} did not settle`);
}

/** Exports a note in `format` through the notes slice and returns the downloaded file's bytes. */
async function exportNote(noteId: string, format: string): Promise<Buffer> {
  const headers = { Authorization: `Bearer ${TOKEN}` };
  const created = await fetch(`${connection.baseUrl}/api/notes/${noteId}/exports`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ format }),
  });
  expect([200, 202], `export ${format}`).toContain(created.status);
  // The Desktop server answers without the web edition's `{ data }` envelope.
  const createdBody = (await created.json()) as { exportId?: string; id?: string };
  const exportId = createdBody.exportId ?? createdBody.id;
  expect(exportId).toBeDefined();
  let url: string | undefined;
  for (let attempt = 0; attempt < 120 && !url; attempt += 1) {
    const download = await fetch(`${connection.baseUrl}/api/notes/exports/${exportId}/download`, { headers });
    if (download.status === 200) url = ((await download.json()) as { url: string }).url;
    else await new Promise((resolve) => setTimeout(resolve, 250));
  }
  expect(url, `${format} export finished`).toBeDefined();
  const file = await fetch(url!.startsWith('http') ? url! : `${connection.baseUrl}${url}`, { headers });
  expect(file.status).toBe(200);
  return Buffer.from(await file.arrayBuffer());
}

beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'kvox-import-'));
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
  });
  connection = { baseUrl: `http://127.0.0.1:${server.port}`, token: TOKEN, userId: server.userId, permissions: [...server.permissions] };
});

afterAll(async () => {
  await server?.close().catch(() => undefined);
  removeQuietly(userDataDir);
});

describe('importLocalFile against the Desktop server', () => {
  it('imports a PDF transcript into an import batch, as a note with its text', async () => {
    const outcome = await importFixture('roadmap-sync-transcript.pdf');

    expect(outcome).toMatchObject({ ok: true, kind: 'batch', filename: 'roadmap-sync-transcript.pdf' });
    if (!outcome.ok) return;
    const [item] = await waitForBatch(outcome.id);
    expect(item).toMatchObject({ filename: 'roadmap-sync-transcript.pdf', path: 'roadmap-sync-transcript.pdf', status: 'imported' });
    const note = await api<{ body: string }>(`/notes/${item!.noteId}`);
    expect(note.body.length).toBeGreaterThan(100);
  });

  it('imports several documents as ONE batch, and a transcript JSON beside them to its own route', async () => {
    const outcomes = await importLocalFiles(
      ['standup.md', 'roadmap-sync-transcript.pdf', 'm03-roadmap-sync.transcript.json'].map((name) => join(FIXTURES, name)),
      { connection, log: (line) => logged.push(line) },
    );

    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]).toMatchObject({ ok: true, kind: 'batch', title: '2 documents' });
    expect(outcomes[1]).toMatchObject({ ok: true, kind: 'transcript' });
    if (!outcomes[0]!.ok) return;
    const items = await waitForBatch(outcomes[0]!.id);
    expect(items.map((item) => item.filename).sort()).toEqual(['roadmap-sync-transcript.pdf', 'standup.md']);
    expect(items.every((item) => item.status === 'imported' && item.noteId !== null)).toBe(true);
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
      const reexported = join(exportDir, 'again.md');
      writeFileSync(reexported, await exportNote(outcome.id, 'markdown'));
      const again = await importLocalFile(reexported, { connection });
      expect(again).toMatchObject({ ok: true, kind: 'note', title: expected.title });
      if (again.ok) expect((await api<{ body: string }>(`/notes/${again.id}`)).body).toBe(expected.body);
    } finally {
      removeQuietly(exportDir);
    }
  });

  it('lists the markdown, PDF and Word exporters, and exports an imported note as a real PDF and a real .docx', async () => {
    const outcome = await importFixture('planning-sync-note.md');
    expect(outcome).toMatchObject({ ok: true, kind: 'note' });
    if (!outcome.ok) return;

    const { exporters } = await api<{ exporters: Array<{ format: string }> }>('/notes/exporters');
    expect(exporters.map((exporter) => exporter.format).sort()).toEqual(['docx', 'markdown', 'pdf']);

    const pdf = await exportNote(outcome.id, 'pdf');
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1024);

    const docx = await exportNote(outcome.id, 'docx');
    expect(docx.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(docx.includes(Buffer.from('word/document.xml', 'latin1'))).toBe(true);
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
