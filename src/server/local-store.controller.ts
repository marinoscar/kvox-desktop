// Copied from marinoscar/kvox examples/bare-host/src/local-store.controller.ts (kvox commit in vendor/kvox/SOURCE.json). A host binding.
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { CurrentKvoxPrincipal, KvoxAuth } from '@marinoscar/kvox-api/core';
import type { KvoxPrincipal } from '@marinoscar/kvox-api/ports';

import type { LocalFsObjectStore } from './ports/local-fs-object-store.js';

// =============================================================================
// LocalStoreController: the loopback side of the local object store
// =============================================================================
//
// Serves the signed URLs `LocalFsObjectStore` hands out, the way an S3 endpoint
// serves presigned ones: the URL IS the credential, so the routes carry no
// `@KvoxAuth` and check the HMAC and the expiry instead.
//
//   PUT /local-store/parts/:objectId/:partNumber?exp=&sig=   one upload part
//   GET /local-store/download/:objectId?exp=&filename=&sig=   the whole object
//
// They live OUTSIDE the `/api` prefix on purpose (see `bootstrap.ts`): a presigned
// URL points at the storage endpoint, not at the application API.
//
// PATH TRAVERSAL: the object id must be a UUID and the storage key is read from
// the database row, never from the URL, so nothing the caller sends reaches the
// file system as a path (the store refuses `..` and absolute keys as well).
// =============================================================================

/** Injection token of the {@link LocalFsObjectStore} the controller serves. */
export const LOCAL_FS_OBJECT_STORE = Symbol.for('kvox-desktop/LOCAL_FS_OBJECT_STORE');

@Controller('local-store')
export class LocalStoreController {
  constructor(@Inject(LOCAL_FS_OBJECT_STORE) private readonly store: LocalFsObjectStore) {}

  @Put('parts/:objectId/:partNumber')
  async putPart(
    @Param('objectId') objectId: string,
    @Param('partNumber') partNumber: string,
    @Query('exp') exp: string | undefined,
    @Query('sig') sig: string | undefined,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ etag: string }> {
    const part = Number(partNumber);
    if (!exp || !sig || !Number.isInteger(part) || !this.store.verifyPartUrl(objectId, part, exp, sig)) {
      throw new UnauthorizedException('The upload URL is invalid or expired');
    }
    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const etag = await this.store.receivePart(objectId, part, body);
    reply.header('ETag', `"${etag}"`);
    return { etag };
  }

  @Get('download/:objectId')
  async download(
    @Param('objectId') objectId: string,
    @Query('exp') exp: string | undefined,
    @Query('filename') filename: string | undefined,
    @Query('sig') sig: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (!exp || !sig || !this.store.verifyDownloadUrl(objectId, exp, filename ?? '', sig)) {
      throw new UnauthorizedException('The download URL is invalid or expired');
    }
    const object = await this.store.openDownload(objectId);
    if (!object) throw new NotFoundException('There is no such object');

    reply.header('Content-Type', object.mimeType);
    reply.header('Content-Length', object.size);
    if (filename) reply.header('Content-Disposition', `attachment; filename="${filename.replace(/["\\\r\n]/g, '_')}"`);
    await reply.send(object.stream);
  }
}

// =============================================================================
// Completing and aborting an upload
// =============================================================================
//
// `POST /api/transcripts` answers with the part URLs and nothing completes the
// upload on its own: sealing it is the HOST's route, because the object store is
// the host's. The web edition's is the platform storage slice's
// `POST /api/storage/objects/:id/upload/complete`; this host serves the same
// path and verbs over `LocalFsObjectStore`, so a client written against one runs
// against the other.
//
// `@KvoxAuth()` with no permission: the caller must be signed in, and an object
// that is not the caller's answers 404, never 403.
// =============================================================================

@Controller('storage/objects')
export class LocalUploadsController {
  constructor(@Inject(LOCAL_FS_OBJECT_STORE) private readonly store: LocalFsObjectStore) {}

  @Post(':id/upload/complete')
  @HttpCode(200)
  @KvoxAuth()
  async complete(
    @Param('id', ParseUUIDPipe) objectId: string,
    @Body() _body: { parts?: Array<{ partNumber: number; etag: string }> },
    @CurrentKvoxPrincipal() principal: KvoxPrincipal,
  ): Promise<{ id: string; status: string }> {
    await this.owned(objectId, principal);
    // The parts' ETags are not needed: this store holds the parts itself.
    await this.store.completeUpload(objectId);
    return { id: objectId, status: (await this.store.head(objectId))?.status ?? 'failed' };
  }

  @Delete(':id/upload/abort')
  @HttpCode(204)
  @KvoxAuth()
  async abort(@Param('id', ParseUUIDPipe) objectId: string, @CurrentKvoxPrincipal() principal: KvoxPrincipal): Promise<void> {
    await this.owned(objectId, principal);
    await this.store.abortUpload(objectId);
  }

  /** The caller's own object, or a 404 that does not say whether it exists. */
  private async owned(objectId: string, principal: KvoxPrincipal): Promise<void> {
    const info = (await this.store.describe([objectId])).get(objectId);
    if (!info || info.ownerId !== principal.userId) throw new NotFoundException('There is no such upload');
  }
}
