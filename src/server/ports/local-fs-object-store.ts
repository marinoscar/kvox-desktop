// From marinoscar/kvox examples/bare-host/src/ports/local-fs-object-store.ts (kvox commit in vendor/kvox/SOURCE.json). A host binding; keep it in step with the bare host.
// Desktop changes (marinoscar/kvox#583): bytes under `<userData>/vault`, and every partial file (upload parts,
// assembly, the temp file of `put`) under `<userData>/tmp/parts`, so the vault only ever holds whole objects.
import { createHmac, randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { BadRequestException, Logger } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';

import {
  KvoxObjectMissingError,
  type KvoxAbortedEvent,
  type KvoxAdoptResult,
  type KvoxInitUploadResult,
  type KvoxManagedBy,
  type KvoxObjectHead,
  type KvoxObjectInfo,
  type KvoxObjectState,
  type KvoxObjectStorePort,
  type KvoxPutResult,
  type KvoxUploadPart,
  type KvoxUploadedEvent,
  type KvoxUploadedOptions,
} from '@marinoscar/kvox-api/ports';

// =============================================================================
// LocalFsObjectStore: KVOX_OBJECT_STORE over a folder (bare host, issue #505)
// =============================================================================
//
// What KVox Desktop takes as a starting point. Every object is a row of the
// platform's `storage_objects` table (the domain tables reference it by foreign
// key: `transcripts.source_object_id`, `notes.source_object_id`, ...) and its
// bytes are a file under `<vaultDir>/<storage_key>` (`<userData>/vault`).
//
// A FILE APPEARS IN THE VAULT WHOLE OR NOT AT ALL: it is written in the parts
// folder and renamed into place (same volume), so a crash never leaves half an
// object where the backup and `openRead` look.
//
// UPLOADS ARE THE SAME TWO-STEP PROTOCOL AS S3, over loopback. `initUpload`
// inserts the row (status `pending`) and returns `http://127.0.0.1:<port>/local-store/parts/<id>/<n>`
// URLs; the client PUTs each part (served by `LocalStoreController`, which calls
// {@link LocalFsObjectStore.receivePart}); `completeUpload` concatenates the
// parts into the final file, marks the row `ready` and fires the `onUploaded`
// handlers. A URL carries an HMAC (a random per-process key) and an expiry, so
// nothing but this process can mint one and none works for long.
//
// WHAT THE ROW NEEDS: `storage_objects` has NOT NULL columns the port knows
// nothing about: `org_id` (the one organization of a single-user host, a
// constructor option), `storage_key` (unique), `storage_provider` (here
// `local`), `size` and `mime_type`.
//
// WHERE `managedBy` LIVES. The web edition keeps the owning module in a side
// table (`kvox_object_ownership`) because `storage_objects` is the platform's
// table. This host has no such table, so the tag is a reserved key of the row's
// `metadata` JSON (`__managedBy`), stripped again before metadata is returned.
//
// A STREAM IS NEVER BUFFERED: `put` and `completeUpload` pipe through the file
// system; `openRead` returns a file stream.
// =============================================================================

const MANAGED_BY_KEY = '__managedBy';
const DEFAULT_PART_SIZE = 5 * 1024 * 1024;
const PART_URL_TTL_SECONDS = 15 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MIME_BY_EXTENSION: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.webm': 'audio/webm',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
};

type StorageRow = {
  id: string;
  name: string;
  size: bigint;
  mimeType: string;
  storageKey: string;
  status: 'pending' | 'uploading' | 'processing' | 'ready' | 'failed';
  metadata: Prisma.JsonValue | null;
  uploadedById: string | null;
  createdAt: Date;
  updatedAt: Date;
};

interface UploadedListener {
  handler: (event: KvoxUploadedEvent) => Promise<void>;
  contentTypes: readonly string[] | undefined;
}

/** Options of {@link LocalFsObjectStore}. */
export interface LocalFsObjectStoreOptions {
  /** The host's Prisma client. */
  prisma: PrismaClient;
  /** The vault: one file per object, at its storage key. */
  vaultDir: string;
  /** Upload parts and partial files; on the same volume as the vault (renames), emptied at start-up. */
  partsDir: string;
  /** The organization every `storage_objects` row belongs to (NOT NULL in the platform table). */
  orgId: string;
  /** The origin the signed URLs point at, resolved when a URL is minted (the port is known only after `listen`). */
  baseUrl: () => string;
  /** The size of every upload part but the last; default 5 MiB. */
  partSize?: number;
}

/** True when `contentType` matches one entry of `allowed` (`audio/*` is a family). */
function matchesType(contentType: string, allowed: readonly string[]): boolean {
  const type = contentType.toLowerCase();
  return allowed.some((entry) => {
    const pattern = entry.toLowerCase();
    return pattern.endsWith('/*') ? type.startsWith(pattern.slice(0, -1)) : type === pattern;
  });
}

/** The reserved tag split off a row's metadata. */
function splitMetadata(metadata: Prisma.JsonValue | null): { managedBy: KvoxManagedBy | null; rest: Record<string, unknown> | null } {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return { managedBy: null, rest: null };
  const { [MANAGED_BY_KEY]: tag, ...rest } = metadata as Record<string, unknown>;
  return {
    managedBy: tag === 'transcripts' || tag === 'notes' || tag === 'graph' ? tag : null,
    rest: Object.keys(rest).length > 0 ? rest : null,
  };
}

/**
 * KVOX_OBJECT_STORE over the local file system.
 *
 * @example
 * ```ts
 * const store = new LocalFsObjectStore({ prisma, vaultDir, partsDir, orgId, baseUrl: () => 'http://127.0.0.1:3000' });
 * ```
 */
export class LocalFsObjectStore implements KvoxObjectStorePort {
  private readonly logger = new Logger('LocalFsObjectStore');
  private readonly prisma: PrismaClient;
  private readonly orgId: string;
  private readonly baseUrl: () => string;
  private readonly partSize: number;
  private readonly objectsDir: string;
  private readonly partsDir: string;
  /** A random key per process: a signed URL is valid for this process only, for a short time. */
  private readonly signingKey = randomBytes(32);
  private readonly uploaded: UploadedListener[] = [];
  private readonly aborted: Array<(event: KvoxAbortedEvent) => Promise<void>> = [];

  constructor(options: LocalFsObjectStoreOptions) {
    this.prisma = options.prisma;
    this.orgId = options.orgId;
    this.baseUrl = options.baseUrl;
    this.partSize = options.partSize ?? DEFAULT_PART_SIZE;
    this.objectsDir = resolve(options.vaultDir);
    this.partsDir = resolve(options.partsDir);
  }

  // -- signed URLs ---------------------------------------------------------------

  private sign(payload: string): string {
    return createHmac('sha256', this.signingKey).update(payload).digest('hex');
  }

  private verify(payload: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(payload), 'hex');
    const given = Buffer.from(signature, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private partUrl(objectId: string, partNumber: number): string {
    const exp = Date.now() + PART_URL_TTL_SECONDS * 1000;
    const sig = this.sign(`part|${objectId}|${partNumber}|${exp}`);
    return `${this.baseUrl()}/local-store/parts/${objectId}/${partNumber}?exp=${exp}&sig=${sig}`;
  }

  /** True when a part URL's signature is genuine and not expired. */
  verifyPartUrl(objectId: string, partNumber: number, exp: string, sig: string): boolean {
    return this.fresh(exp) && this.verify(`part|${objectId}|${partNumber}|${exp}`, sig);
  }

  /** True when a download URL's signature is genuine and not expired. */
  verifyDownloadUrl(objectId: string, exp: string, filename: string, sig: string): boolean {
    return this.fresh(exp) && this.verify(`download|${objectId}|${exp}|${filename}`, sig);
  }

  private fresh(exp: string): boolean {
    const at = Number(exp);
    return Number.isFinite(at) && at > Date.now();
  }

  // -- paths ---------------------------------------------------------------------

  /**
   * The file of a storage key. Refuses an absolute key, a `..` segment and a NUL byte, and, on every OS, a
   * backslash or a drive prefix: a key must name the same file on Windows, macOS and Linux (a backup moves).
   */
  private pathOfKey(key: string): string {
    if (
      key.length === 0 ||
      key.includes('\0') ||
      key.includes('\\') ||
      /^[a-zA-Z]:/.test(key) ||
      isAbsolute(key) ||
      key.split('/').includes('..')
    ) {
      throw new Error(`Refusing the unsafe storage key "${key}"`);
    }
    const path = resolve(this.objectsDir, key);
    if (!path.startsWith(this.objectsDir + sep)) throw new Error(`Refusing the storage key "${key}": it leaves the object folder`);
    return path;
  }

  private partsOf(objectId: string): string {
    if (!UUID.test(objectId)) throw new Error(`Refusing the object id "${objectId}"`);
    return join(this.partsDir, objectId);
  }

  // -- rows ----------------------------------------------------------------------

  private async row(objectId: string): Promise<StorageRow | null> {
    if (!UUID.test(objectId)) return null;
    return (await this.prisma.storageObject.findUnique({ where: { id: objectId } })) as StorageRow | null;
  }

  private async requireRow(objectId: string): Promise<StorageRow> {
    const row = await this.row(objectId);
    if (!row) throw new Error(`Object ${objectId} does not exist`);
    return row;
  }

  private async insertRow(input: {
    id?: string;
    key: string;
    name: string;
    mimeType: string;
    size: number;
    status: 'pending' | 'ready';
    ownerId: string;
    managedBy: KvoxManagedBy;
    metadata?: Record<string, unknown>;
  }): Promise<StorageRow> {
    return (await this.prisma.storageObject.create({
      data: {
        ...(input.id ? { id: input.id } : {}),
        name: input.name,
        size: BigInt(input.size),
        mimeType: input.mimeType,
        storageKey: input.key,
        storageProvider: 'local',
        status: input.status,
        metadata: { ...(input.metadata ?? {}), [MANAGED_BY_KEY]: input.managedBy } as Prisma.InputJsonValue,
        uploadedById: input.ownerId,
        orgId: this.orgId,
      },
    })) as StorageRow;
  }

  // -- uploads -------------------------------------------------------------------

  async initUpload(
    ctx: { userId: string },
    req: { name: string; mimeType?: string | null; size: number; managedBy: KvoxManagedBy; allowedMimeTypes?: readonly string[] },
  ): Promise<KvoxInitUploadResult> {
    const extension = extname(req.name).toLowerCase();
    const reported = req.mimeType?.trim().toLowerCase();
    const mimeType =
      reported && reported !== 'application/octet-stream' ? reported : (MIME_BY_EXTENSION[extension] ?? 'application/octet-stream');
    if (req.allowedMimeTypes && req.allowedMimeTypes.length > 0 && !matchesType(mimeType, req.allowedMimeTypes)) {
      throw new BadRequestException(`Files of type ${mimeType} are not accepted here`);
    }
    if (!Number.isSafeInteger(req.size) || req.size < 0) throw new BadRequestException('The file size must be a non-negative integer');

    const objectId = randomUUID();
    // A randomized file name: what the user called the file is `name`, never a path.
    const key = `${req.managedBy}/${objectId}/${randomBytes(8).toString('hex')}${extension.replace(/[^.\w]/g, '')}`;
    await this.insertRow({
      id: objectId,
      key,
      name: basename(req.name).slice(0, 200) || 'upload',
      mimeType,
      size: req.size,
      status: 'pending',
      ownerId: ctx.userId,
      managedBy: req.managedBy,
    });

    const totalParts = Math.max(1, Math.ceil(req.size / this.partSize));
    return {
      objectId,
      uploadId: objectId,
      partSize: this.partSize,
      totalParts,
      parts: this.partsFor(objectId, 1, totalParts),
    };
  }

  private partsFor(objectId: string, from: number, to: number): KvoxUploadPart[] {
    const parts: KvoxUploadPart[] = [];
    for (let partNumber = from; partNumber <= to; partNumber += 1) parts.push({ partNumber, url: this.partUrl(objectId, partNumber) });
    return parts;
  }

  async signParts(objectId: string, partNumbers: number[]): Promise<KvoxUploadPart[]> {
    await this.requireRow(objectId);
    return partNumbers.map((partNumber) => ({ partNumber, url: this.partUrl(objectId, partNumber) }));
  }

  /**
   * Stores one part of an upload in flight. Called by `LocalStoreController` after it checked the URL's signature.
   *
   * @returns the part's ETag (an MD5 digest, as S3 reports).
   */
  async receivePart(objectId: string, partNumber: number, body: Buffer): Promise<string> {
    const row = await this.row(objectId);
    if (!row || (row.status !== 'pending' && row.status !== 'uploading')) throw new BadRequestException('There is no upload in flight for this object');
    const totalParts = Math.max(1, Math.ceil(Number(row.size) / this.partSize));
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > totalParts) throw new BadRequestException(`Part ${partNumber} is outside 1..${totalParts}`);
    if (body.length > this.partSize) throw new BadRequestException(`A part is at most ${this.partSize} bytes`);

    const dir = this.partsOf(objectId);
    await mkdir(dir, { recursive: true });
    await pipeline(Readable.from([body]), createWriteStream(join(dir, String(partNumber))));
    if (row.status === 'pending') await this.prisma.storageObject.update({ where: { id: objectId }, data: { status: 'uploading' } });
    return createHash('md5').update(body).digest('hex');
  }

  async completeUpload(objectId: string): Promise<void> {
    const row = await this.requireRow(objectId);
    if (row.status === 'ready') return;
    if (row.status !== 'pending' && row.status !== 'uploading') throw new BadRequestException(`The upload is ${row.status}`);

    const totalParts = Math.max(1, Math.ceil(Number(row.size) / this.partSize));
    const dir = this.partsOf(objectId);
    const present = new Set(await readdir(dir).catch(() => [] as string[]));
    for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) {
      if (!present.has(String(partNumber)) && !(row.size === 0n && partNumber === 1)) {
        throw new BadRequestException(`Part ${partNumber} of ${totalParts} has not been uploaded`);
      }
    }

    const target = this.pathOfKey(row.storageKey);
    await mkdir(dirname(target), { recursive: true });
    await mkdir(this.partsDir, { recursive: true });
    const assembled = join(this.partsDir, `${objectId}.assembling`);
    const out = createWriteStream(assembled);
    for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) {
      if (!present.has(String(partNumber))) continue;
      await pipeline(createReadStream(join(dir, String(partNumber))), out, { end: false });
    }
    await new Promise<void>((done, fail) => out.end((error?: Error | null) => (error ? fail(error) : done())));
    await rename(assembled, target);
    const size = (await stat(target)).size;
    await rm(dir, { recursive: true, force: true });

    await this.prisma.storageObject.update({ where: { id: objectId }, data: { status: 'ready', size: BigInt(size) } });
    const { managedBy } = splitMetadata(row.metadata);
    await this.fireUploaded({ objectId, managedBy }, row.mimeType);
  }

  private async fireUploaded(event: KvoxUploadedEvent, mimeType: string): Promise<void> {
    for (const listener of this.uploaded) {
      if (listener.contentTypes && listener.contentTypes.length > 0 && !matchesType(mimeType, listener.contentTypes)) continue;
      try {
        await listener.handler(event);
      } catch (error) {
        // A handler is a bystander of the upload: its failure never un-completes the bytes.
        this.logger.error(`An onUploaded handler failed for ${event.objectId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async abortUpload(objectId: string): Promise<void> {
    const row = await this.row(objectId);
    if (!row || (row.status !== 'pending' && row.status !== 'uploading')) return;
    await rm(this.partsOf(objectId), { recursive: true, force: true });
    // The row stays, marked failed: a transcript that was waiting for it still references it.
    await this.prisma.storageObject.update({ where: { id: objectId }, data: { status: 'failed' } });
    const { managedBy } = splitMetadata(row.metadata);
    for (const handler of this.aborted) {
      try {
        await handler({ objectId, managedBy });
      } catch (error) {
        this.logger.error(`An onAborted handler failed for ${objectId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // -- bytes ---------------------------------------------------------------------

  async put(req: {
    ownerId: string;
    key: string;
    body: NodeJS.ReadableStream | Buffer;
    contentType: string;
    managedBy: KvoxManagedBy;
    name?: string;
    metadata?: Record<string, unknown>;
  }): Promise<KvoxPutResult> {
    const path = this.pathOfKey(req.key);
    const existing = await this.byKey(req.key);
    if (existing) return { objectId: existing.id, size: Number(existing.size) };

    await mkdir(dirname(path), { recursive: true });
    await mkdir(this.partsDir, { recursive: true });
    const temp = join(this.partsDir, `put-${randomBytes(8).toString('hex')}.tmp`);
    let size = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        callback(null, chunk);
      },
    });
    const source = Buffer.isBuffer(req.body) ? Readable.from([req.body]) : (req.body as Readable);
    try {
      await pipeline(source, counter, createWriteStream(temp));
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }

    try {
      const row = await this.insertRow({
        key: req.key,
        name: req.name ?? (basename(req.key) || 'object'),
        mimeType: req.contentType,
        size,
        status: 'ready',
        ownerId: req.ownerId,
        managedBy: req.managedBy,
        metadata: req.metadata,
      });
      return { objectId: row.id, size };
    } catch (error) {
      // A concurrent put of the same key won the unique index: answer its object.
      const winner = await this.byKey(req.key);
      if (winner) return { objectId: winner.id, size: Number(winner.size) };
      // The bytes are taken back when the row could not be written.
      await rm(path, { force: true });
      throw error;
    }
  }

  private async byKey(key: string): Promise<StorageRow | null> {
    return (await this.prisma.storageObject.findUnique({ where: { storageKey: key } })) as StorageRow | null;
  }

  async adopt(req: {
    ownerId: string;
    key: string;
    name: string;
    contentType: string;
    size: number;
    managedBy: KvoxManagedBy;
    metadata?: Record<string, unknown>;
  }): Promise<KvoxAdoptResult> {
    const path = this.pathOfKey(req.key);
    const existing = await this.byKey(req.key);
    if (existing) return { objectId: existing.id };
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new KvoxObjectMissingError(req.key);
    const row = await this.insertRow({
      key: req.key,
      name: req.name,
      mimeType: req.contentType,
      size: info.size,
      status: 'ready',
      ownerId: req.ownerId,
      managedBy: req.managedBy,
      metadata: req.metadata,
    });
    return { objectId: row.id };
  }

  async openRead(objectId: string): Promise<NodeJS.ReadableStream> {
    const row = await this.requireRow(objectId);
    return createReadStream(this.pathOfKey(row.storageKey));
  }

  async head(objectId: string): Promise<KvoxObjectHead | null> {
    const row = await this.row(objectId);
    if (!row) return null;
    return {
      size: Number(row.size),
      mimeType: row.mimeType,
      status: row.status === 'ready' ? 'ready' : row.status === 'failed' ? 'failed' : 'pending',
    };
  }

  async describe(objectIds: readonly string[]): Promise<Map<string, KvoxObjectInfo>> {
    const ids = [...new Set(objectIds)].filter((id) => UUID.test(id));
    const result = new Map<string, KvoxObjectInfo>();
    if (ids.length === 0) return result;
    const rows = (await this.prisma.storageObject.findMany({ where: { id: { in: ids } } })) as StorageRow[];
    for (const row of rows) {
      const { managedBy, rest } = splitMetadata(row.metadata);
      result.set(row.id, {
        id: row.id,
        name: row.name,
        mimeType: row.mimeType,
        size: Number(row.size),
        state: row.status as KvoxObjectState,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        ownerId: row.uploadedById,
        managedBy,
        metadata: rest,
      });
    }
    return result;
  }

  async setMetadata(objectId: string, metadata: Record<string, unknown>): Promise<void> {
    const row = await this.row(objectId);
    if (!row) return;
    const { managedBy } = splitMetadata(row.metadata);
    const next = { ...metadata, ...(managedBy ? { [MANAGED_BY_KEY]: managedBy } : {}) };
    await this.prisma.storageObject.update({ where: { id: objectId }, data: { metadata: next as Prisma.InputJsonValue } });
  }

  async listManaged(query: { ownerId: string; managedBy: KvoxManagedBy; keyPrefix?: string; limit: number }): Promise<string[]> {
    const prefix = query.keyPrefix === undefined ? Prisma.empty : Prisma.sql`AND starts_with(storage_key, ${query.keyPrefix})`;
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id::text AS id FROM storage_objects
       WHERE uploaded_by_id = ${query.ownerId}::uuid
         AND metadata ->> ${MANAGED_BY_KEY} = ${query.managedBy}
         ${prefix}
       ORDER BY id
       LIMIT ${query.limit}`);
    return rows.map((row) => row.id);
  }

  async signedDownloadUrl(objectId: string, opts: { ttlSeconds: number; filename?: string }): Promise<string> {
    await this.requireRow(objectId);
    const exp = Date.now() + opts.ttlSeconds * 1000;
    const filename = opts.filename ?? '';
    const sig = this.sign(`download|${objectId}|${exp}|${filename}`);
    return `${this.baseUrl()}/local-store/download/${objectId}?exp=${exp}&filename=${encodeURIComponent(filename)}&sig=${sig}`;
  }

  /** The row and file of a download whose URL the controller already verified. */
  async openDownload(objectId: string): Promise<{ stream: NodeJS.ReadableStream; mimeType: string; size: number; name: string } | null> {
    const row = await this.row(objectId);
    if (!row || row.status !== 'ready') return null;
    const path = this.pathOfKey(row.storageKey);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) return null;
    return { stream: createReadStream(path), mimeType: row.mimeType, size: info.size, name: row.name };
  }

  async delete(objectId: string): Promise<void> {
    const row = await this.row(objectId);
    if (!row) return;
    await rm(this.pathOfKey(row.storageKey), { force: true });
    await rm(this.partsOf(objectId), { recursive: true, force: true });
    await this.prisma.storageObject.deleteMany({ where: { id: objectId } });
  }

  onUploaded(handler: (event: KvoxUploadedEvent) => Promise<void>, options?: KvoxUploadedOptions): void {
    this.uploaded.push({ handler, contentTypes: options?.contentTypes });
  }

  onAborted(handler: (event: KvoxAbortedEvent) => Promise<void>): void {
    this.aborted.push(handler);
  }

  /** The folder an object's bytes live in, for the README and the tests ("rows and files are gone"). */
  get objectFolder(): string {
    return this.objectsDir;
  }
}
