import 'reflect-metadata';

import multipart from '@fastify/multipart';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { KvoxEventEmitterEvents } from '@marinoscar/kvox-api/core';

import { DESKTOP_AI_SETTINGS_NAMESPACE } from './ai/desktop-ai-settings.js';
import { DesktopAi, loadProviderAdapters, type DesktopAiAdapters } from './ai/desktop-ai.js';
import { createDesktopModule } from './app.module.js';
import { applyPendingRestore, discardPreviousData, shippedMigrations } from './backup/backup.js';
import { registerBackupJobs } from './backup/backup-jobs.js';
import { dataFolder } from './data-folder.js';
import { PGLITE_EXTENSIONS, createPrismaClient, startDatabase } from './database.js';
import { EgressGuard } from './egress-guard.js';
import { DesktopNotify } from './ports/desktop-notify.js';
import { JsonlAudit } from './ports/jsonl-audit.js';
import { LaunchTokenIdentity } from './ports/launch-token-identity.js';
import { LocalFsObjectStore } from './ports/local-fs-object-store.js';
import { PgSettings } from './ports/pg-settings.js';
import { PgTableJobs } from './ports/pg-table-jobs.js';
import { SafeStorageSecrets, type SecretCipher } from './ports/safe-storage-secrets.js';
import { LOCAL_USER_PERMISSIONS } from './permissions.js';
import { LOCAL_USER_ID, seedDatabase } from './seed.js';

// =============================================================================
// Starting the local server (marinoscar/kvox#582, #583)
// =============================================================================
//
// The bare host's bootstrap (examples/bare-host/src/bootstrap.ts) in an Electron
// utility process: PGlite under `<userData>/db`, the vault, logs and secrets
// under `<userData>` (`data-folder.ts`), Nest on Fastify listening on 127.0.0.1
// at a port the system picks, every route behind the per-launch token.
//
// THE PORTS (one file each under `ports/`; ADR-0001: they are the only
// Desktop-specific backend code):
//   objectStore  LocalFsObjectStore   <userData>/vault, rows in storage_objects
//   jobs         PgTableJobs          the jobs table, timeouts, back-off, crash recovery
//   identity     LaunchTokenIdentity  the seeded user, the per-launch token
//   settings     PgSettings           system_settings / user_settings
//   secrets      SafeStorageSecrets   safeStorage blobs in secrets.bin (via main)
//   notify       DesktopNotify        an OS notification (via main), no content
//   events       KvoxEventEmitterEvents (the package default, bound explicitly)
//   audit        JsonlAudit           logs/audit.log, ids and counts
//   prisma       the PGlite-backed client, one connection
//   ai           DesktopAi            createKvoxAi over createDirectRuntime: the platform
//                                     OpenAI / OpenAI-compatible adapters, keys from
//                                     KVOX_SECRETS, the `desktopAi` settings (#584)
//
// THE ORDER: egress guard first (nothing may leave before it), then a staged
// restore (before PGlite opens the folder), the database, the seed, the AI
// settings (which narrow the allowlist to the configured provider's host), Nest
// (the slices register their handlers and namespaces), the backup handlers,
// crash recovery of the job table, and only then the job loop.
// =============================================================================

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
  /** Receives error lines (blocked egress). Defaults to `log`. */
  logError?: (line: string) => void;
  /** The app's version, recorded in a backup. */
  appVersion: string;
  /** Electron `safeStorage`, through the main process. */
  cipher: SecretCipher;
  /** Shows an OS notification (the main process). */
  showNotification: (title: string, body: string) => void;
  /** Asks the main process to restart the server (a restore is staged). */
  requestRestart: (reason: string) => void;
}

/** A running local server. */
export interface RunningServer {
  readonly port: number;
  readonly userId: string;
  readonly permissions: readonly string[];
  readonly timings: Record<string, number>;
  readonly egress: EgressGuard;
  close(): Promise<void>;
}

/** Brings the database up, seeds it, boots Nest on Fastify and listens on loopback. */
export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const started = performance.now();
  const egress = new EgressGuard({ logError: options.logError ?? options.log });
  egress.install();
  options.log(`server: egress guard on, allowing loopback and ${egress.allowedHosts.join(', ')}`);

  const folder = dataFolder(options.userDataDir);
  const restored = await applyPendingRestore(folder, PGLITE_EXTENSIONS, options.log).catch(() => false);
  const database = await startDatabase({
    appRoot: options.appRoot,
    dataDir: folder.db,
    nodeExecutable: options.nodeExecutable,
    log: options.log,
  });
  if (restored) await discardPreviousData(folder);
  const prisma = createPrismaClient(database);
  const timings: Record<string, number> = { ...database.timings };

  let jobs: PgTableJobs | undefined;
  let app: NestFastifyApplication | undefined;
  let providers: DesktopAiAdapters | undefined;
  try {
    const orgId = await seedDatabase(prisma);

    let baseUrl = '';
    jobs = new PgTableJobs(prisma, { dataDir: options.userDataDir, orgId, log: options.log });
    const objectStore = new LocalFsObjectStore({ prisma, vaultDir: folder.vault, partsDir: folder.uploadParts, orgId, baseUrl: () => baseUrl });
    const settings = new PgSettings(prisma);
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
    settings.registerNamespace(DESKTOP_AI_SETTINGS_NAMESPACE);
    const secrets = new SafeStorageSecrets({ file: folder.secrets, cipher: options.cipher, log: options.log });
    providers = await loadProviderAdapters();
    const desktopAi = new DesktopAi({
      settings,
      secrets,
      adapters: providers.adapters,
      onAllowedHosts: (hosts) => {
        egress.allow(hosts);
        options.log(`server: egress allowlist is loopback${hosts.length > 0 ? ` and ${hosts.join(', ')}` : ' only'}`);
      },
    });
    await desktopAi.applyEgress();
    const identity = new LaunchTokenIdentity({
      userId: LOCAL_USER_ID,
      orgId,
      permissions: LOCAL_USER_PERMISSIONS,
      token: options.token,
    });

    app = await NestFactory.create<NestFastifyApplication>(
      createDesktopModule({
        objectStore,
        desktopAi,
        egress,
        ports: {
          ai: { useValue: desktopAi.port },
          objectStore: { useValue: objectStore },
          jobs: { useValue: jobs },
          identity: { useValue: identity },
          notify: { useValue: new DesktopNotify({ show: (n) => options.showNotification(n.title, n.body), appName: 'KVox Desktop', log: options.log }) },
          settings: { useValue: settings },
          secrets: { useValue: secrets },
          events: { useValue: new KvoxEventEmitterEvents() },
          audit: { useValue: new JsonlAudit(folder.auditLog) },
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
    // The uploads are multipart: the document source (`POST /api/notes/sources/documents`) and
    // the two imports (`POST /api/transcripts/imports`, `POST /api/notes/import`, #585). The
    // slices read them through `@fastify/multipart`, which the host registers; each route sets
    // its own size limit on the read.
    await app.register(multipart);
    app.setGlobalPrefix('api', { exclude: ['local-store/*path'] });
    // Upload parts arrive with the file's own content type: hand the bytes through.
    app.getHttpAdapter().getInstance().addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;

    registerBackupJobs(jobs, {
      folder,
      appVersion: options.appVersion,
      dumpDatabase: () => database.dump(),
      migrations: async () =>
        (
          await prisma.$queryRaw<Array<{ name: string }>>(Prisma.sql`
            SELECT migration_name AS name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`)
        ).map((row) => row.name),
      knownMigrations: () => shippedMigrations(options.appRoot),
      onRestoreStaged: () => options.requestRestart('a restore is staged'),
      log: options.log,
    });
    const recovered = await jobs.recoverInterrupted();
    if (recovered.requeued + recovered.failed > 0) {
      options.log(`jobs: ${recovered.requeued} interrupted job(s) queued again, ${recovered.failed} failed`);
    }
    jobs.start();
    timings.serverStart = Math.round(performance.now() - started);
    options.log(`server: listening on ${baseUrl} (${JSON.stringify(timings)})`);

    const running = { jobs, app, providers };
    return {
      port,
      userId: LOCAL_USER_ID,
      permissions: LOCAL_USER_PERMISSIONS,
      timings,
      egress,
      async close() {
        await running.jobs.stop();
        await running.app.close();
        await running.providers.close();
        await prisma.$disconnect();
        await database.close();
      },
    };
  } catch (error) {
    await jobs?.stop().catch(() => undefined);
    await app?.close().catch(() => undefined);
    await providers?.close().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    await database.close().catch(() => undefined);
    throw error;
  }
}
