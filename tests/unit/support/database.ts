import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { PrismaClient } from '@prisma/client';

import { createPrismaClient, startDatabase, type DesktopDatabase } from '../../../src/server/database';
import { seedDatabase } from '../../../src/server/seed';

// A real PGlite database for the port tests: the app's own start-up sequence
// (`startDatabase`: extensions, `prisma migrate deploy`, `kvox-db check`) on a
// temporary user data folder, run with this Node instead of Electron's. Needs
// `npm run prepare:db` first (CI runs it before the unit tests).

/** Removes a test folder; a file Windows still holds open is left for the OS to clean. */
export function removeQuietly(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // EBUSY on Windows right after a process died: harmless in a temp folder.
  }
}

export const ROOT = resolve(__dirname, '..', '..', '..');

export interface TestDatabase {
  userDataDir: string;
  database: DesktopDatabase;
  prisma: PrismaClient;
  orgId: string;
  close(options?: { keepFolder?: boolean }): Promise<void>;
}

/** A fresh user data folder, or `userDataDir` when given. */
export async function openTestDatabase(userDataDir = mkdtempSync(join(tmpdir(), 'kvox-unit-'))): Promise<TestDatabase> {
  const database = await startDatabase({ appRoot: ROOT, dataDir: join(userDataDir, 'db'), nodeExecutable: process.execPath, log: () => undefined });
  const prisma = createPrismaClient(database);
  const orgId = await seedDatabase(prisma);
  return {
    userDataDir,
    database,
    prisma,
    orgId,
    async close(options) {
      await prisma.$disconnect().catch(() => undefined);
      await database.close().catch(() => undefined);
      if (!options?.keepFolder) removeQuietly(userDataDir);
    },
  };
}

/** A reversible stand-in for Electron `safeStorage` (the tests run outside Electron). */
export function fakeCipher(status: { available?: boolean; backend?: string | null; plaintextAccepted?: boolean } = {}) {
  return {
    status: async () => ({ available: status.available ?? true, backend: status.backend ?? null, plaintextAccepted: status.plaintextAccepted ?? false }),
    encrypt: async (value: string) => Buffer.from(`enc:${value}`).toString('base64').split('').reverse().join(''),
    decrypt: async (blob: string) => Buffer.from(blob.split('').reverse().join(''), 'base64').toString().replace(/^enc:/, ''),
  };
}
