import { Module, type DynamicModule } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';

import { KvoxPortsModule, type KvoxPortBindings } from '@marinoscar/kvox-api/core';
import { NotesModule } from '@marinoscar/kvox-api/notes';
import { SearchIndexingModule, SearchModule } from '@marinoscar/kvox-api/search';
import { TranscriptionModule } from '@marinoscar/kvox-api/transcription';
import { TranscriptsModule } from '@marinoscar/kvox-api/transcripts';

import type { DesktopAi } from './ai/desktop-ai.js';
import { DESKTOP_AI, DESKTOP_EGRESS, DesktopAiController } from './desktop-ai.controller.js';
import { DesktopDataController } from './desktop-data.controller.js';
import { LOCAL_FS_OBJECT_STORE, LocalStoreController, LocalUploadsController } from './local-store.controller.js';
import type { LocalFsObjectStore } from './ports/local-fs-object-store.js';
import type { EgressGuard } from './egress-guard.js';
import { StorageObjectsController } from './storage-objects.controller.js';

// =============================================================================
// The application module of KVox Desktop (D1 spike: notes and its peers)
// =============================================================================
//
// The bare host's wiring (examples/bare-host/src/app.module.ts) with Desktop's
// switches:
//
//   TranscriptionModule  NO provider at all (ADR-0006: Desktop has no
//                        transcription); it is here because transcripts, a
//                        peer of notes, needs it.
//   SearchModule         full text (the AI binding offers no embeddings model)
//   TranscriptsModule    no schedules, no transcode, no PDF exporter
//   NotesModule          no schedules, no PDF/Word exporter, no PDF source;
//                        text and Markdown documents are a source
//
// `schedules: false` everywhere: the housekeeping enqueuers are called on the
// host's own timer (still to wire). The ports module comes first (it is global), then the
// slices in dependency order, each given its peers' very module objects.
// =============================================================================

/** KVOX_BRAND: the product name a slice prints (an export footer) and the slug it builds file names from. */
export const DESKTOP_BRAND = { appName: 'KVox Desktop', appSlug: 'kvox' };

/** Everything `createDesktopModule` wires. */
export interface DesktopModuleOptions {
  /** The port bindings (all ten, events and audit included). */
  ports: KvoxPortBindings;
  /** The object store the loopback controller serves. */
  objectStore: LocalFsObjectStore;
  /** The KVOX_AI binding and the provider settings (`/api/desktop/ai`). */
  desktopAi: DesktopAi;
  /** The egress guard whose allowlist the AI settings drive. */
  egress: EgressGuard;
}

@Module({})
class DesktopModule {}

/** Builds the application module around already-constructed ports. */
export function createDesktopModule(options: DesktopModuleOptions): DynamicModule {
  const transcription = TranscriptionModule.forRoot({ providers: { assemblyai: false } });
  const searchIndexing = SearchIndexingModule.forRoot();
  const transcripts = TranscriptsModule.forRoot({
    schedules: false,
    media: { transcode: false },
    exporters: { pdf: false },
    peers: { transcription, searchIndexing },
  });
  const notes = NotesModule.forRoot({
    schedules: false,
    exporters: { pdf: false, docx: false },
    documentSources: { pdf: false },
    peers: { transcripts, searchIndexing },
  });

  return {
    module: DesktopModule,
    imports: [
      KvoxPortsModule.forRoot({ ports: options.ports, brand: DESKTOP_BRAND }),
      transcription,
      SearchModule.forRoot(),
      searchIndexing,
      transcripts,
      notes,
    ],
    controllers: [LocalStoreController, LocalUploadsController, StorageObjectsController, DesktopAiController, DesktopDataController],
    providers: [
      { provide: LOCAL_FS_OBJECT_STORE, useValue: options.objectStore },
      { provide: DESKTOP_AI, useValue: options.desktopAi },
      { provide: DESKTOP_EGRESS, useValue: options.egress },
      { provide: APP_PIPE, useClass: ZodValidationPipe },
    ],
  };
}
