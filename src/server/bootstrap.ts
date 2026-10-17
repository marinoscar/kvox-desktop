import 'reflect-metadata';

import { join } from 'node:path';

import multipart from '@fastify/multipart';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { z } from 'zod';

import { createFakeKvoxAi, createRecordingKvoxNotify } from '@marinoscar/kvox-api/testing';

import { createDesktopModule } from './app.module.js';
import { createPrismaClient, startDatabase } from './database.js';
import { FileSettings } from './ports/file-settings.js';
import { LaunchTokenIdentity } from './ports/launch-token-identity.js';
import { LocalFsObjectStore } from './ports/local-fs-object-store.js';
import { MemorySecrets } from './ports/memory-secrets.js';
import { PgTableJobs } from './ports/pg-table-jobs.js';
import { LOCAL_USER_PERMISSIONS } from './permissions.js';
import { LOCAL_USER_ID, seedDatabase } from './seed.js';

// =============================================================================
// Starting the local server (marinoscar/kvox#582)
// =============================================================================
//
// The bare host's bootstrap (examples/bare-host/src/bootstrap.ts) in an Electron
// utility process: PGlite under `<userData>/db`, the objects, settings and
// scratch files under `<userData>`, Nest on Fastify listening on 127.0.0.1 at a
// port the system picks, every route behind the per-launch token.
//
// D1 BINDINGS (what later steps replace):
//   ai        createFakeKvoxAi (a fixed note body, no embeddings)  -> D3 (#584)
//   secrets   MemorySecrets                                        -> D2 OS keychain (#583)
//   notify    createRecordingKvoxNotify                            -> D2 OS notifications
// =============================================================================

/** What the fake model "writes" for every note (the smoke test looks for the last line). */
export const FAKE_NOTE_TEXT = [
  '# Meeting notes\n\n',
  'Generated on this device by the KVox Desktop stack spike.\n\n',
  '- The local server, the database and the job runner run in a utility process.\n',
  '- Desktop smoke marker: zebracorn.\n',
];

/** Options of {@link startServer}. */
export interface StartServerOptions {
  /** `app.getAppPath()`. */
  appRoot: string;
  /** `app.getPath('userData')`. */
  userDataDir: string;
  /** The Electron binary, for the migration child processes. */
  nodeExecutable: string;
  /** The per-launch token. */
  token: string;
  /** Origins allowed to call the API (the renderer's). */
  allowedOrigins: readonly string[];
  /** Receives progress lines. */
  log: (line: string) => void;
}

/** A running local server. */
export interface RunningServer {
  readonly port: number;
  readonly userId: string;
  readonly permissions: readonly string[];
  readonly timings: Record<string, number>;
  close(): Promise<void>;
}

/** Brings the database up, seeds it, boots Nest on Fastify and listens on loopback. */
export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const started = performance.now();
  const database = await startDatabase({
    appRoot: options.appRoot,
    dataDir: join(options.userDataDir, 'db'),
    nodeExecutable: options.nodeExecutable,
    log: options.log,
  });
  const prisma = createPrismaClient(database);
  const timings: Record<string, number> = { ...database.timings };

  let jobs: PgTableJobs | undefined;
  let app: NestFastifyApplication | undefined;
  try {
    const orgId = await seedDatabase(prisma);

    let baseUrl = '';
    const objectStore = new LocalFsObjectStore({ prisma, dataDir: options.userDataDir, orgId, baseUrl: () => baseUrl });
    jobs = new PgTableJobs(prisma, { dataDir: options.userDataDir, orgId });
    const settings = new FileSettings(join(options.userDataDir, 'settings.json'));
    // THE `ai` SYSTEM NAMESPACE IS THE HOST'S TO DECLARE (kvox-ports.md 3.8); the slices only read it.
    settings.registerNamespace({
      scope: 'system',
      name: 'ai',
      schema: z.object({
        maxInputTokens: z.number().int().positive().nullable().default(null),
        maxOutputTokens: z.number().int().positive().nullable().default(null),
        maxDocumentBytes: z.number().int().positive().default(10 * 1024 * 1024),
      }),
      defaults: { maxInputTokens: null, maxOutputTokens: null, maxDocumentBytes: 10 * 1024 * 1024 },
    });
    const ai = createFakeKvoxAi({ script: { text: FAKE_NOTE_TEXT, capabilities: { embeddings: null } } });
    const identity = new LaunchTokenIdentity({
      userId: LOCAL_USER_ID,
      orgId,
      permissions: LOCAL_USER_PERMISSIONS,
      token: options.token,
    });

    app = await NestFactory.create<NestFastifyApplication>(
      createDesktopModule({
        objectStore,
        ports: {
          ai: { useValue: ai },
          objectStore: { useValue: objectStore },
          jobs: { useValue: jobs },
          identity: { useValue: identity },
          notify: { useValue: createRecordingKvoxNotify() },
          settings: { useValue: settings },
          secrets: { useValue: new MemorySecrets() },
          prisma: { useValue: prisma as never },
        },
      }),
      new FastifyAdapter({ bodyLimit: 64 * 1024 * 1024 }),
      { logger: ['error', 'warn'] },
    );

    // The renderer is another origin (kvox://app, or the dev server): allow exactly it.
    app.enableCors({
      origin: [...options.allowedOrigins],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type', 'Accept', 'Last-Event-ID', 'If-None-Match'],
      exposedHeaders: ['Content-Disposition', 'ETag'],
      maxAge: 600,
    });
    // The document-source upload (`POST /api/notes/sources/documents`) is multipart; the slice
    // reads it through `@fastify/multipart`, which the host registers.
    await app.register(multipart);
    app.setGlobalPrefix('api', { exclude: ['local-store/*path'] });
    // Upload parts arrive with the file's own content type: hand the bytes through.
    app.getHttpAdapter().getInstance().addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;

    jobs.start();
    timings.serverStart = Math.round(performance.now() - started);
    options.log(`server: listening on ${baseUrl} (${JSON.stringify(timings)})`);

    const running = { jobs, app };
    return {
      port,
      userId: LOCAL_USER_ID,
      permissions: LOCAL_USER_PERMISSIONS,
      timings,
      async close() {
        await running.jobs.stop();
        await running.app.close();
        await prisma.$disconnect();
        await database.close();
      },
    };
  } catch (error) {
    await jobs?.stop().catch(() => undefined);
    await app?.close().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    await database.close().catch(() => undefined);
    throw error;
  }
}
