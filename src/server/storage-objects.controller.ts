import { Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe } from '@nestjs/common';

import { CurrentKvoxPrincipal, KvoxAuth } from '@marinoscar/kvox-api/core';
import type { KvoxPrincipal } from '@marinoscar/kvox-api/ports';

import { LOCAL_FS_OBJECT_STORE } from './local-store.controller.js';
import type { LocalFsObjectStore } from './ports/local-fs-object-store.js';

// =============================================================================
// GET /api/storage/objects/:id: one stored object, as its owner sees it
// =============================================================================
//
// The notes screen polls this route while `note.source.extract` reads an
// uploaded document (`getNoteDocumentExtraction` in
// @marinoscar/kvox-web/notes/headless reads `metadata.noteSourceExtraction`).
// In the web edition it is the platform storage slice's route; like the upload
// completion route next to it, it belongs to whoever owns the object store,
// which here is the host. It reads the KVOX_OBJECT_STORE binding and nothing
// else: the caller's own object or a 404 that does not say whether it exists.
// =============================================================================

@Controller('storage/objects')
export class StorageObjectsController {
  constructor(@Inject(LOCAL_FS_OBJECT_STORE) private readonly store: LocalFsObjectStore) {}

  @Get(':id')
  @KvoxAuth()
  async get(@Param('id', ParseUUIDPipe) objectId: string, @CurrentKvoxPrincipal() principal: KvoxPrincipal) {
    const info = (await this.store.describe([objectId])).get(objectId);
    if (!info || info.ownerId !== principal.userId) throw new NotFoundException('There is no such object');
    return {
      id: info.id,
      name: info.name,
      mimeType: info.mimeType,
      size: info.size,
      status: info.state,
      metadata: info.metadata ?? null,
      createdAt: info.createdAt,
      updatedAt: info.updatedAt,
    };
  }
}
