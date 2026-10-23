import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { opendir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { normalizeLibraryPath } from '@marinoscar/kvox-contract/notes';

import { FILES_MAX_READ_BYTES, type FilesEntry } from '../../shared/protocol';
import { FilesError, resolveInside } from './paths';

// =============================================================================
// Walking, hashing and reading a folder (marinoscar/kvox-desktop#47)
// =============================================================================
//
// What the file port needs from disk, nothing more: a recursive walk that
// skips hidden entries and `node_modules` and never follows a symbolic link
// (the port's documented contract, the browser implementation's rule too), a
// streaming SHA-256, and a bounded read. Which extensions count is the
// caller's (`NOTE_IMPORT_EXTENSIONS` of the contract, passed by kvox-web).
// =============================================================================

const SKIPPED_DIRECTORIES = new Set(['node_modules']);

/** A hidden name (`.git`, `.DS_Store`) or a skipped directory. */
export function isSkippedName(name: string): boolean {
  return name.startsWith('.') || SKIPPED_DIRECTORIES.has(name);
}

/** The extensions as a lower-case set without dots (`['.MD', 'pdf']` -> `{md, pdf}`). */
export function extensionSet(extensions: readonly string[]): Set<string> {
  return new Set(extensions.filter((value) => typeof value === 'string').map((value) => value.replace(/^\./, '').toLowerCase()));
}

function hasExtension(name: string, extensions: ReadonlySet<string>): boolean {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return false;
  return extensions.has(name.slice(dot + 1).toLowerCase());
}

/**
 * Walks `root` depth first and yields every regular file with one of `extensions`, its path relative to the
 * root (POSIX, `normalizeLibraryPath`). Symbolic links, hidden entries and `node_modules` are skipped; a
 * directory that cannot be read (permissions) is skipped too, the rest of the walk goes on.
 */
export async function* walkFolder(root: string, extensions: ReadonlySet<string>, prefix = ''): AsyncGenerator<FilesEntry> {
  let dir;
  try {
    dir = await opendir(prefix === '' ? root : join(root, ...prefix.split('/')));
  } catch {
    if (prefix === '') throw new FilesError('not_found', 'The folder is no longer on this computer.');
    return;
  }
  for await (const entry of dir) {
    if (isSkippedName(entry.name) || entry.isSymbolicLink()) continue;
    const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      yield* walkFolder(root, extensions, relativePath);
      continue;
    }
    if (!entry.isFile() || !hasExtension(entry.name, extensions)) continue;
    const path = normalizeLibraryPath(relativePath);
    if (path === null) continue;
    const info = await stat(join(root, ...path.split('/'))).catch(() => null);
    if (!info?.isFile()) continue;
    yield { path, size: info.size, mtime: Math.trunc(info.mtimeMs) };
  }
}

/** The lower-case hex SHA-256 of a file inside `root`, streamed (never read whole). */
export async function hashFile(root: string, relativePath: unknown): Promise<string> {
  const { absolute } = await resolveInside(root, relativePath);
  const hash = createHash('sha256');
  await new Promise<void>((resolveHash, reject) => {
    const stream = createReadStream(absolute);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', () => reject(new FilesError('not_found', 'The file could not be read.')));
    stream.on('end', () => resolveHash());
  });
  return hash.digest('hex');
}

/** The bytes of a file inside `root`, refused (`too_large`) over `maxBytes`. */
export async function readFileInside(root: string, relativePath: unknown, maxBytes = FILES_MAX_READ_BYTES): Promise<ArrayBuffer> {
  const { path, absolute } = await resolveInside(root, relativePath);
  const info = await stat(absolute).catch(() => null);
  if (!info?.isFile()) throw new FilesError('not_found', `No file "${path}" in the folder.`);
  if (info.size > maxBytes) {
    throw new FilesError('too_large', `"${path}" is larger than ${Math.round(maxBytes / (1024 * 1024))} MB, the most KVox reads.`);
  }
  const buffer = await readFile(absolute).catch(() => {
    throw new FilesError('not_found', `"${path}" could not be read.`);
  });
  if (buffer.byteLength > maxBytes) throw new FilesError('too_large', `"${path}" is larger than KVox reads.`);
  // A fresh ArrayBuffer of exactly the file (a Buffer may be a view on a shared pool).
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}
