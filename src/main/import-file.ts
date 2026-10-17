import { openAsBlob } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';

import { KVOX_IMPORT_SNIFF_BYTES, detectKvoxImport, type KvoxImportKind } from '@marinoscar/kvox-contract/notes';

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
//      note Markdown export, or a PDF/Markdown/text note source.
//   2. The file is streamed (`openAsBlob`, never read whole here) as the one
//      `file` part of a multipart POST, with the per-launch token.
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

/**
 * Imports one local file: sniffs it, streams it to the route the contract names, and
 * reports what the server created or why it refused.
 */
export async function importLocalFile(path: string, options: ImportLocalFileOptions): Promise<ImportOutcome> {
  const filename = basename(path);
  const log = options.log ?? (() => undefined);
  const started = performance.now();

  if (!isAbsolute(path)) return { ok: false, filename, message: `"${filename}" is not a file on this computer.` };
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return { ok: false, filename, message: `"${filename}" is not a file KVox can read.` };

  const target = detectKvoxImport({ filename, head: await readHead(path) });
  const form = new FormData();
  form.append('file', await openAsBlob(path, { type: target.mimeType }), filename);

  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${options.connection.baseUrl}/api${target.route}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.connection.token}` },
      body: form,
    });
  } catch {
    // The server stops reading at its limit and may close the connection before the
    // upload ends; the only other cause is a server that is not there.
    log(`import: ${target.kind} could not be sent (${info.size} bytes)`);
    return {
      ok: false,
      filename,
      message: `"${filename}" could not be sent to the local server. It may be larger than KVox accepts for this kind of file.`,
    };
  }

  const body = (await response.json().catch(() => null)) as unknown;
  log(`import: ${target.kind} answered ${response.status} in ${Math.round(performance.now() - started)} ms`);
  if (!response.ok) return refusal(filename, response.status, body);
  return created(target.kind, filename, (unwrap(body) ?? {}) as CreatedBody);
}
