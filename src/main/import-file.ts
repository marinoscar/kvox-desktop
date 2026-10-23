import { openAsBlob } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';

import { KVOX_IMPORT_SNIFF_BYTES, detectKvoxImport, type KvoxImportKind, type KvoxImportTarget } from '@marinoscar/kvox-contract/notes';

import type { DesktopConnection, ImportOutcome } from '../shared/protocol';

// =============================================================================
// Importing one local file into the local server (marinoscar/kvox#585)
// =============================================================================
//
// The main process reads a file the user chose (the native dialog) or dropped
// on the window, and streams it to the local server's EXISTING upload routes,
// the same ones the web edition uses. Nothing here parses a format (ADR-0001):
//
//   1. The first bytes go to `detectKvoxImport` (`@marinoscar/kvox-contract`),
//      which names the route and the media type: a transcript JSON export, a
//      note Markdown export, or a note document (Markdown, text, PDF, Word,
//      PowerPoint).
//   2. The file is streamed (`openAsBlob`, never read whole here) as the one
//      `file` part of a multipart POST, with the per-launch token. Note
//      documents go into ONE ad-hoc import batch per drop or dialog
//      (marinoscar/kvox-desktop#47): `POST /notes/import-batches`, then each
//      file to `/notes/import-batches/:id/files` (`path` = its file name,
//      `mtime`), then `/close`, exactly the calls kvox-web's
//      `importFilesAdHoc` makes from a browser `File`. They are made here
//      because the files are on disk in this process: nothing is read into
//      the page, and the window opens the batch's progress page.
//   3. The slice answers. A refusal is its own 400 (`details.reason` and a
//      sentence a person can read) or 413 (its own size limit, enforced while
//      it reads the stream); this module only relays it.
//
// The only traffic is to 127.0.0.1 (ADR-0004). Logs carry the kind, the status
// and the time, never the file's name or content.
// =============================================================================

type Fetch = typeof fetch;

/** What the server answers for each kind, as far as this module reads it. */
interface CreatedBody {
  batchId?: unknown;
  id?: unknown;
  title?: unknown;
  objectId?: unknown;
  filename?: unknown;
}

/** The first `KVOX_IMPORT_SNIFF_BYTES` of a file. */
async function readHead(path: string): Promise<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const buffer = new Uint8Array(KVOX_IMPORT_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** The `{ data }` envelope's content, or the body itself. */
function unwrap(body: unknown): unknown {
  return body !== null && typeof body === 'object' && 'data' in body ? (body as { data: unknown }).data : body;
}

/** A sentence for a refusal: the slice's own message when it sent one. */
function refusal(filename: string, status: number, body: unknown): ImportOutcome {
  const error = (body ?? {}) as { message?: unknown; details?: { reason?: unknown } };
  const message = Array.isArray(error.message) ? error.message.join('; ') : error.message;
  const reason = typeof error.details?.reason === 'string' ? error.details.reason : undefined;
  return {
    ok: false,
    filename,
    status,
    ...(reason ? { reason } : {}),
    message:
      typeof message === 'string' && message.length > 0
        ? message
        : status === 413
          ? `"${filename}" is larger than KVox accepts for this kind of file.`
          : `"${filename}" could not be imported (the local server answered ${status}).`,
  };
}

function created(kind: KvoxImportKind, filename: string, body: CreatedBody): ImportOutcome {
  if (kind === 'note_markdown' && typeof body.id === 'string') {
    return { ok: true, kind: 'note', id: body.id, title: typeof body.title === 'string' ? body.title : filename, filename };
  }
  if (kind === 'transcript_json' && typeof body.id === 'string') {
    return { ok: true, kind: 'transcript', id: body.id, title: typeof body.title === 'string' ? body.title : filename, filename };
  }
  if (typeof body.objectId === 'string') {
    return { ok: true, kind: 'document', id: body.objectId, title: typeof body.filename === 'string' ? body.filename : filename, filename };
  }
  return { ok: false, filename, message: `"${filename}" was sent, but the local server's answer was not understood.` };
}

/** Options of {@link importLocalFile}. */
export interface ImportLocalFileOptions {
  connection: DesktopConnection;
  log?: (line: string) => void;
  /** For tests. */
  fetch?: Fetch;
}

/** A local file, checked and sniffed: what the contract says to send it as. */
interface SniffedFile {
  path: string;
  filename: string;
  size: number;
  mtime: number;
  target: KvoxImportTarget;
}

/** Checks that `path` is a local file and asks the contract what it is; a refusal when it is not a file. */
async function sniff(path: string): Promise<SniffedFile | Extract<ImportOutcome, { ok: false }>> {
  const filename = basename(path);
  if (!isAbsolute(path)) return { ok: false, filename, message: `"${filename}" is not a file on this computer.` };
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return { ok: false, filename, message: `"${filename}" is not a file KVox can read.` };
  const target = detectKvoxImport({ filename, head: await readHead(path) });
  return { path, filename, size: info.size, mtime: Math.trunc(info.mtimeMs), target };
}

/** POSTs a multipart form (or nothing) to the local server; `null` when the server could not be reached. */
async function post(options: ImportLocalFileOptions, route: string, form?: FormData): Promise<{ status: number; ok: boolean; body: unknown } | null> {
  try {
    const response = await (options.fetch ?? fetch)(`${options.connection.baseUrl}/api${route}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.connection.token}` },
      ...(form ? { body: form } : {}),
    });
    return { status: response.status, ok: response.ok, body: (await response.json().catch(() => null)) as unknown };
  } catch {
    return null;
  }
}

/** The sentence for a file the server could not be reached for (or that stopped reading at its limit). */
function unsent(filename: string): ImportOutcome {
  return {
    ok: false,
    filename,
    message: `"${filename}" could not be sent to the local server. It may be larger than KVox accepts for this kind of file.`,
  };
}

/** Streams one sniffed file to the single-upload route the contract names (transcripts, note exports). */
async function importOne(file: SniffedFile, options: ImportLocalFileOptions): Promise<ImportOutcome> {
  const log = options.log ?? (() => undefined);
  const started = performance.now();
  const form = new FormData();
  form.append('file', await openAsBlob(file.path, { type: file.target.mimeType }), file.filename);
  const answer = await post(options, file.target.route, form);
  if (!answer) {
    // The server stops reading at its limit and may close the connection before the
    // upload ends; the only other cause is a server that is not there.
    log(`import: ${file.target.kind} could not be sent (${file.size} bytes)`);
    return unsent(file.filename);
  }
  log(`import: ${file.target.kind} answered ${answer.status} in ${Math.round(performance.now() - started)} ms`);
  if (!answer.ok) return refusal(file.filename, answer.status, answer.body);
  return created(file.target.kind, file.filename, (unwrap(answer.body) ?? {}) as CreatedBody);
}

/**
 * Note documents into one ad-hoc import batch: open it, stream each file into it, close it. Answers the
 * batch (when at least one file went in) and a refusal per file that did not.
 */
async function importDocuments(files: readonly SniffedFile[], options: ImportLocalFileOptions): Promise<ImportOutcome[]> {
  const log = options.log ?? (() => undefined);
  const started = performance.now();
  const opened = await post(options, files[0]!.target.route);
  const batchId = opened?.ok ? (unwrap(opened.body) as CreatedBody | null)?.batchId : undefined;
  if (typeof batchId !== 'string') {
    log(`import: note_document batch could not be opened (${opened?.status ?? 'unreachable'})`);
    return files.map((file) => (opened ? refusal(file.filename, opened.status, opened.body) : unsent(file.filename)));
  }
  const filesRoute = `${files[0]!.target.route}/${encodeURIComponent(batchId)}/files`;
  const failures: ImportOutcome[] = [];
  let accepted = 0;
  try {
    for (const file of files) {
      const form = new FormData();
      // Fields before the file: the server's streaming multipart reader sees them first.
      form.append('path', file.filename);
      form.append('mtime', String(file.mtime));
      form.append('file', await openAsBlob(file.path, { type: file.target.mimeType }), file.filename);
      const answer = await post(options, filesRoute, form);
      if (!answer) failures.push(unsent(file.filename));
      else if (!answer.ok) failures.push(refusal(file.filename, answer.status, answer.body));
      else accepted += 1;
    }
  } finally {
    // An empty batch must not stay `running`; the server closes a filled one when its items settle.
    await post(options, `${files[0]!.target.route}/${encodeURIComponent(batchId)}/close`);
  }
  log(`import: note_document batch of ${files.length} (${accepted} accepted) in ${Math.round(performance.now() - started)} ms`);
  if (accepted === 0) return failures;
  return [{ ok: true, kind: 'batch', id: batchId, title: `${accepted} ${accepted === 1 ? 'document' : 'documents'}`, filename: files[0]!.filename }, ...failures];
}

/**
 * Imports local files: each is sniffed; note documents go into one import batch, every other kind to its own
 * route, one after the other (the single-writer database). A file that cannot be read is refused alone.
 */
export async function importLocalFiles(paths: readonly string[], options: ImportLocalFileOptions): Promise<ImportOutcome[]> {
  const log = options.log ?? (() => undefined);
  const outcomes: ImportOutcome[] = [];
  const documents: SniffedFile[] = [];
  const others: SniffedFile[] = [];
  for (const path of paths) {
    const file = await sniff(path).catch((error: unknown): ImportOutcome => {
      log(`import: failed: ${error instanceof Error ? error.name : 'error'}`);
      return { ok: false, filename: basename(path), message: 'This file could not be read.' };
    });
    if ('ok' in file) outcomes.push(file);
    else if (file.target.kind === 'note_document') documents.push(file);
    else others.push(file);
  }
  if (documents.length > 0) outcomes.push(...(await importDocuments(documents, options)));
  for (const file of others) {
    outcomes.push(
      await importOne(file, options).catch((error: unknown): ImportOutcome => {
        log(`import: failed: ${error instanceof Error ? error.name : 'error'}`);
        return { ok: false, filename: file.filename, message: 'This file could not be read.' };
      }),
    );
  }
  return outcomes;
}

/**
 * Imports one local file: sniffs it, streams it to the route the contract names (a note document into an
 * import batch of its own), and reports what the server created or why it refused.
 */
export async function importLocalFile(path: string, options: ImportLocalFileOptions): Promise<ImportOutcome> {
  const file = await sniff(path);
  if ('ok' in file) return file;
  if (file.target.kind === 'note_document') {
    const outcomes = await importDocuments([file], options);
    return outcomes.find((outcome) => outcome.ok) ?? outcomes[0]!;
  }
  return importOne(file, options);
}
