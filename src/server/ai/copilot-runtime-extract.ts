import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createGunzip } from 'node:zlib';

// =============================================================================
// A small, strict .tgz extractor for the Copilot runtime (marinoscar/kvox-desktop#32)
// =============================================================================
//
// `prepareCopilotRuntime({ download: { extract } })` hands the host the VERIFIED
// archive (its SHA-256 matched the pin) and an empty directory. Node has no tar,
// and a dependency is more code to audit than this reader, which accepts only what
// the registry package contains and refuses everything else:
//
//   - regular files and directories only: a symbolic link, a hard link, a device
//     or any other entry type is refused outright, so no link can ever point out of
//     the destination and a later entry cannot be written through one;
//   - a name that is absolute, has a drive letter, a backslash or a NUL, or has a
//     ".." segment is refused; the first segment must be `package` and is stripped;
//   - the resolved path must stay inside the destination (checked again after join);
//   - files are created with `wx`, so a duplicate entry (or one over an existing
//     link) is an error and nothing is overwritten;
//   - per-entry, total and entry-count limits, enforced from the headers before a
//     byte is written (a gzip bomb cannot expand past them: only declared bytes are
//     read);
//   - header checksums are verified; a truncated archive is an error;
//   - modes: setuid/setgid/sticky never survive; an executable file becomes 0755,
//     everything else 0644; the launcher is made 0755 on POSIX.
//
// The archive is data: nothing in it is executed here.
// =============================================================================

/** The archive broke a rule above. The message names the entry, never its content. */
export class UnsafeArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeArchiveError';
  }
}

/** Limits of one extraction. The defaults fit the 160 MB `@github/copilot-sdk-<platform>` packages with room to spare. */
export interface ExtractLimits {
  /** The most entries (files, directories and metadata). */
  maxEntries: number;
  /** The largest single file in bytes. */
  maxEntryBytes: number;
  /** The most bytes across all files. */
  maxTotalBytes: number;
}

export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = Object.freeze({
  maxEntries: 20_000,
  maxEntryBytes: 512 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
});

/** Options of {@link extractCopilotRuntimeTgz}. */
export interface ExtractOptions {
  /** The launcher, relative to the package root (`prebuilds/linux-x64/copilot-runtime`). It must be a file in the archive. */
  launcher: string;
  limits?: Partial<ExtractLimits>;
  /** Default `process.platform`; the executable bit is applied unless `win32`. */
  platform?: NodeJS.Platform;
}

const BLOCK = 512;
const EMPTY = Buffer.alloc(0);
const MAX_METADATA_BYTES = 1024 * 1024;
/** The one top-level folder every npm tarball has. */
const PACKAGE_ROOT = 'package';

/** Pulls exact byte counts out of an async chunk source. */
class ChunkReader {
  private pending: Buffer = EMPTY;
  private done = false;

  constructor(private readonly iterator: AsyncIterator<Buffer>) {}

  private async fill(): Promise<boolean> {
    if (this.done) return false;
    const next = await this.iterator.next();
    if (next.done) {
      this.done = true;
      return false;
    }
    this.pending = this.pending.length === 0 ? next.value : Buffer.concat([this.pending, next.value]);
    return true;
  }

  /** Exactly `length` bytes, or `null` at a clean end of data (no byte read). Throws on a partial read. */
  async readExact(length: number): Promise<Buffer | null> {
    while (this.pending.length < length) {
      if (!(await this.fill())) {
        if (this.pending.length === 0) return null;
        throw new UnsafeArchiveError('The archive is truncated.');
      }
    }
    const out = this.pending.subarray(0, length);
    this.pending = this.pending.subarray(length);
    return out;
  }

  /** Yields the next `length` bytes in chunks; throws when the archive ends first. */
  async *stream(length: number): AsyncGenerator<Buffer> {
    let left = length;
    while (left > 0) {
      if (this.pending.length === 0 && !(await this.fill())) throw new UnsafeArchiveError('The archive is truncated.');
      const take = Math.min(left, this.pending.length);
      yield this.pending.subarray(0, take);
      this.pending = this.pending.subarray(take);
      left -= take;
    }
  }

  async skip(length: number): Promise<void> {
    for await (const chunk of this.stream(length)) void chunk;
  }
}

function cString(buffer: Buffer): string {
  const end = buffer.indexOf(0);
  return buffer.subarray(0, end === -1 ? buffer.length : end).toString('utf8');
}

function octal(buffer: Buffer, what: string): number {
  // GNU base-256 sizes (high bit set) are for entries over 8 GiB: far beyond every limit.
  if (buffer.length > 0 && (buffer[0]! & 0x80) !== 0) throw new UnsafeArchiveError(`The archive has an oversized ${what}.`);
  const text = cString(buffer).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new UnsafeArchiveError(`The archive has a corrupt ${what}.`);
  return parseInt(text, 8);
}

function verifyChecksum(header: Buffer): void {
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
  if (sum !== octal(header.subarray(148, 156), 'header checksum')) throw new UnsafeArchiveError('The archive has a corrupt header.');
}

/** A pax extended-header body: "<len> <key>=<value>\n" records. Only `path` and `size` are honoured. */
function parsePax(body: Buffer): { path?: string; size?: number } {
  const out: { path?: string; size?: number } = {};
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number(body.subarray(offset, space).toString('ascii'));
    if (!Number.isInteger(length) || length <= space - offset || offset + length > body.length) {
      throw new UnsafeArchiveError('The archive has a corrupt extended header.');
    }
    const record = body.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals > 0) {
      const key = record.slice(0, equals);
      const value = record.slice(equals + 1);
      if (key === 'path') out.path = value;
      if (key === 'size') {
        const size = Number(value);
        if (!Number.isInteger(size) || size < 0) throw new UnsafeArchiveError('The archive has a corrupt extended header.');
        out.size = size;
      }
    }
    offset += length;
  }
  return out;
}

/**
 * Turns an archive entry name into path segments under the package root, or throws.
 * `null`: the package root itself (nothing to create).
 */
export function entrySegments(rawName: string): string[] | null {
  if (rawName === '' || rawName.includes('\0') || rawName.includes('\\')) throw new UnsafeArchiveError('The archive has an entry with an unsafe name.');
  if (rawName.startsWith('/') || /^[A-Za-z]:/.test(rawName)) throw new UnsafeArchiveError('The archive has an absolute entry path.');
  const segments = rawName.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) throw new UnsafeArchiveError('The archive has an entry that climbs out of its folder.');
  if (segments[0] !== PACKAGE_ROOT) throw new UnsafeArchiveError('The archive is not an npm package (no "package/" root).');
  return segments.length === 1 ? null : segments.slice(1);
}

function insideOrThrow(destination: string, target: string): void {
  const rel = relative(destination, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new UnsafeArchiveError('The archive has an entry that resolves outside its folder.');
  }
}

/**
 * Belt and braces: after a directory is created, its REAL path (links resolved) must still be the
 * destination or inside it. The destination is empty and we create no links, so this only fires if
 * something else planted one; it must never let a write follow it out.
 */
async function assertRealInside(realRoot: string, directory: string): Promise<void> {
  const real = await realpath(directory);
  const rel = relative(realRoot, real);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new UnsafeArchiveError('The archive has an entry that resolves outside its folder.');
}

/**
 * Extracts the verified `.tgz` of a runtime package into `destination` (an existing, empty directory)
 * with the package's own layout (`builtin/`, `prebuilds/<platform>/...` beside each other, `package/`
 * stripped), and returns the launcher's absolute path.
 */
export async function extractCopilotRuntimeTgz(archivePath: string, destination: string, options: ExtractOptions): Promise<string> {
  const limits = { ...DEFAULT_EXTRACT_LIMITS, ...options.limits };
  const platform = options.platform ?? process.platform;
  const root = resolve(destination);
  const launcherSegments = entrySegments(`${PACKAGE_ROOT}/${options.launcher}`);
  if (!launcherSegments) throw new UnsafeArchiveError('The launcher path is empty.');
  const launcherPath = join(root, ...launcherSegments);
  insideOrThrow(root, launcherPath);

  const realRoot = await realpath(root);
  const input = createReadStream(archivePath);
  const gunzip = createGunzip();
  input.on('error', (error) => gunzip.destroy(error));
  input.pipe(gunzip);
  const reader = new ChunkReader((gunzip as AsyncIterable<Buffer>)[Symbol.asyncIterator]());

  let entries = 0;
  let totalBytes = 0;
  let sawLauncher = false;
  let longName: string | undefined;
  let pax: { path?: string; size?: number } = {};
  const created = new Set<string>();

  try {
    for (;;) {
      const header = await reader.readExact(BLOCK);
      if (header === null) break;
      if (header.every((byte) => byte === 0)) break; // end-of-archive marker
      verifyChecksum(header);
      entries += 1;
      if (entries > limits.maxEntries) throw new UnsafeArchiveError('The archive has too many entries.');

      const type = String.fromCharCode(header[156] || 0x30);
      const prefix = cString(header.subarray(345, 500));
      const headerName = cString(header.subarray(0, 100));
      const declaredSize = octal(header.subarray(124, 136), 'entry size');
      const mode = octal(header.subarray(100, 108), 'entry mode');

      // Metadata entries: their body describes the NEXT entry.
      if (type === 'L' || type === 'x' || type === 'g') {
        if (declaredSize > MAX_METADATA_BYTES) throw new UnsafeArchiveError('The archive has an oversized metadata entry.');
        const body = (await reader.readExact(declaredSize)) ?? EMPTY;
        await reader.skip(Math.ceil(declaredSize / BLOCK) * BLOCK - declaredSize);
        if (type === 'L') longName = cString(body);
        else if (type === 'x') pax = parsePax(body);
        continue;
      }

      const rawName = longName ?? pax.path ?? (prefix ? `${prefix}/${headerName}` : headerName);
      const size = pax.size ?? declaredSize;
      longName = undefined;
      pax = {};

      if (type !== '0' && type !== '5') {
        // '1' hard link, '2' symbolic link, '3'/'4' devices, '6' fifo, '7' contiguous and anything else.
        throw new UnsafeArchiveError(`The archive has a ${type === '2' ? 'symbolic link' : type === '1' ? 'hard link' : 'special'} entry, which is refused.`);
      }

      const segments = entrySegments(rawName);
      const padding = Math.ceil(size / BLOCK) * BLOCK - size;

      if (type === '5') {
        if (size !== 0) throw new UnsafeArchiveError('The archive has a directory with a body.');
        if (segments) {
          const directory = join(root, ...segments);
          insideOrThrow(root, directory);
          await mkdir(directory, { recursive: true });
          await assertRealInside(realRoot, directory);
        }
        continue;
      }

      if (!segments) throw new UnsafeArchiveError('The archive has a file where its root folder should be.');
      if (size > limits.maxEntryBytes) throw new UnsafeArchiveError('The archive has an entry over the size limit.');
      totalBytes += size;
      if (totalBytes > limits.maxTotalBytes) throw new UnsafeArchiveError('The archive is over the total size limit.');
      const target = join(root, ...segments);
      insideOrThrow(root, target);
      if (created.has(target)) throw new UnsafeArchiveError('The archive has a duplicate entry.');
      created.add(target);

      await mkdir(dirname(target), { recursive: true });
      await assertRealInside(realRoot, dirname(target));
      // `wx`: never overwrite, never write through an existing link.
      const handle = await open(target, 'wx', mode & 0o111 ? 0o755 : 0o644);
      try {
        for await (const chunk of reader.stream(size)) await handle.write(chunk);
      } finally {
        await handle.close();
      }
      await reader.skip(padding);
      if (target === launcherPath) sawLauncher = true;
    }
  } finally {
    input.destroy();
    gunzip.destroy();
  }

  if (!sawLauncher) throw new UnsafeArchiveError('The archive does not contain the runtime launcher.');
  const info = await lstat(launcherPath);
  if (!info.isFile() || info.size === 0) throw new UnsafeArchiveError('The runtime launcher is not a file.');
  if (platform !== 'win32') await chmod(launcherPath, 0o755);
  return launcherPath;
}
