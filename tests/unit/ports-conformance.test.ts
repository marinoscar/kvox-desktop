import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { KvoxEventEmitterEvents } from '@marinoscar/kvox-api/core';
import { createFakeKvoxExecutionContext, describeKvoxPortsConformance, type KvoxPortsUnderTest } from '@marinoscar/kvox-api/testing';

import { dataFolder } from '../../src/server/data-folder';
import { DesktopNotify } from '../../src/server/ports/desktop-notify';
import { JsonlAudit } from '../../src/server/ports/jsonl-audit';
import { LaunchTokenIdentity } from '../../src/server/ports/launch-token-identity';
import { LocalFsObjectStore } from '../../src/server/ports/local-fs-object-store';
import { PgSettings } from '../../src/server/ports/pg-settings';
import { PgTableJobs } from '../../src/server/ports/pg-table-jobs';
import { SafeStorageSecrets } from '../../src/server/ports/safe-storage-secrets';
import { LOCAL_USER_PERMISSIONS } from '../../src/server/permissions';
import { LOCAL_USER_ID } from '../../src/server/seed';
import { fakeCipher, openTestDatabase, type TestDatabase } from './support/database';

// =============================================================================
// describeKvoxPortsConformance against the Desktop adapters (marinoscar/kvox#583)
// =============================================================================
//
// The package's executable definition of a correct port binding, run against
// the very classes `bootstrap.ts` wires, over a real PGlite database:
// the vault object store, the table-backed job runner, the launch-token
// identity, the table-backed settings, the safeStorage secrets (with a stand-in
// cipher: `safeStorage` exists only inside Electron), the OS notifier (with a
// recording `show`), the events default and the audit log.
//
// `ai` is skipped here: tests/unit/desktop-ai.test.ts runs the AI kit
// (`describeKvoxAiConformance`) over the Desktop binding (marinoscar/kvox#584).
//
// THE UPLOAD RULE SENDS ITS BYTES: the store refuses to seal an upload whose parts
// never arrived, so `uploadParts` checks each signed part URL and hands the bytes
// to `receivePart`, the method the loopback controller calls.
// =============================================================================

const TOKEN = 'conformance-launch-token-0123456789abcdefghij';
let db: TestDatabase;
let objectStore: LocalFsObjectStore;
let jobs: PgTableJobs;
let sequence = 0;
const scratch = mkdtempSync(join(tmpdir(), 'kvox-conformance-'));

beforeAll(async () => {
  db = await openTestDatabase();
  const folder = dataFolder(db.userDataDir);
  objectStore = new LocalFsObjectStore({
    prisma: db.prisma,
    vaultDir: folder.vault,
    partsDir: folder.uploadParts,
    orgId: db.orgId,
    baseUrl: () => 'http://127.0.0.1:1',
  });
  jobs = new PgTableJobs(db.prisma, { dataDir: db.userDataDir, orgId: db.orgId, log: () => undefined });
});

afterAll(async () => {
  await jobs?.stop();
  await db?.close();
});

async function desktopPorts(): Promise<KvoxPortsUnderTest> {
  sequence += 1;
  return {
    objectStore: {
      port: objectStore,
      ownerId: LOCAL_USER_ID,
      async uploadParts(init, size) {
        for (const part of init.parts) {
          const url = new URL(part.url);
          const [, , , objectId, partNumber] = url.pathname.split('/');
          const ok = objectStore.verifyPartUrl(objectId, Number(partNumber), url.searchParams.get('exp') ?? '', url.searchParams.get('sig') ?? '');
          if (!ok) throw new Error(`part URL ${part.partNumber} does not verify`);
          const length = Math.min(init.partSize, size - (part.partNumber - 1) * init.partSize);
          await objectStore.receivePart(objectId, Number(partNumber), Buffer.alloc(Math.max(length, 0), part.partNumber));
        }
      },
    },
    jobs: { port: jobs, drain: async () => void (await jobs.drain()) },
    identity: {
      port: new LaunchTokenIdentity({ userId: LOCAL_USER_ID, orgId: db.orgId, permissions: LOCAL_USER_PERMISSIONS, token: TOKEN }),
      anonymous: createFakeKvoxExecutionContext(),
      authenticated: createFakeKvoxExecutionContext({ authorization: `Bearer ${TOKEN}` }),
      permissions: { granted: 'notes:read', notGranted: 'conformance:not_granted' },
    },
    notify: {
      port: new DesktopNotify({ show: () => undefined, appName: 'KVox Desktop' }),
      event: { key: 'kvox.conformance.event', userId: LOCAL_USER_ID },
    },
    events: { port: new KvoxEventEmitterEvents() },
    settings: {
      port: new PgSettings(db.prisma),
      namespaces: [
        {
          scope: 'system',
          name: `conformance_system_${sequence}`,
          schema: z.object({ enabled: z.boolean(), label: z.string() }),
          defaults: { enabled: false, label: '' },
        },
        { scope: 'user', name: `conformance_user_${sequence}`, schema: z.object({ theme: z.string() }), defaults: { theme: 'light' } },
      ],
      system: { name: `conformance_system_${sequence}`, patch: { enabled: true, label: 'x' }, actorUserId: LOCAL_USER_ID },
      user: { name: `conformance_user_${sequence}`, userId: LOCAL_USER_ID, patch: { theme: 'dark' } },
    },
    secrets: {
      port: new SafeStorageSecrets({ file: join(scratch, `secrets-${sequence}.bin`), cipher: fakeCipher() }),
      purpose: 'conformance',
      name: 'default',
      actorUserId: LOCAL_USER_ID,
    },
    audit: { port: new JsonlAudit(join(scratch, `audit-${sequence}.log`)) },
  };
}

describeKvoxPortsConformance('desktop', desktopPorts, { describe, it, expect }, { skip: ['ai'] });

// -- what the kit does not state ----------------------------------------------------

describe('desktop: KVOX_OBJECT_STORE beyond the kit', () => {
  it('keeps the bytes under <userData>/vault/<key>, whole, and delete removes the file and the row', async () => {
    const key = `notes/${Date.now()}/doc.txt`;
    const { objectId } = await objectStore.put({ ownerId: LOCAL_USER_ID, key, body: Buffer.from('vault bytes'), contentType: 'text/plain', managedBy: 'notes' });
    const file = join(dataFolder(db.userDataDir).vault, ...key.split('/'));
    expect(readFileSync(file, 'utf8')).toBe('vault bytes');
    // Nothing partial is ever left next to the object.
    expect(readdirSync(dirname(file))).toEqual(['doc.txt']);
    await objectStore.delete(objectId);
    expect(existsSync(file)).toBe(false);
    expect(await db.prisma.storageObject.findUnique({ where: { id: objectId } })).toBeNull();
  });

  it.each([['../escape.txt'], ['notes/../../escape.txt'], ['/etc/passwd'], ['C:\\Windows\\win.ini'], ['notes/\0nul']])(
    'refuses the storage key %j',
    async (key) => {
      await expect(objectStore.put({ ownerId: LOCAL_USER_ID, key, body: Buffer.from('x'), contentType: 'text/plain', managedBy: 'notes' })).rejects.toThrow();
    },
  );
});

describe('desktop: KVOX_SETTINGS beyond the kit', () => {
  it('reads an unwritten namespace with no defaults as undefined (kvox#593)', async () => {
    const settings = new PgSettings(db.prisma);
    settings.registerNamespace({ scope: 'user', name: 'graph_like', schema: z.object({ depth: z.number() }), defaults: undefined });
    settings.registerNamespace({ scope: 'system', name: 'system_no_defaults', schema: z.object({ on: z.boolean() }), defaults: undefined });
    expect(await settings.readUser(LOCAL_USER_ID, 'graph_like')).toBeUndefined();
    expect((await settings.readSystem('system_no_defaults')).value).toBeUndefined();
    await settings.patchUser(LOCAL_USER_ID, 'graph_like', { depth: 2 });
    expect(await settings.readUser(LOCAL_USER_ID, 'graph_like')).toEqual({ depth: 2 });
  });

  it('refuses a stale ifMatchVersion and keeps user namespaces apart', async () => {
    const settings = new PgSettings(db.prisma);
    settings.registerNamespace({ scope: 'system', name: 'versioned', schema: z.object({ n: z.number() }), defaults: { n: 0 } });
    settings.registerNamespace({ scope: 'user', name: 'a', schema: z.object({ v: z.string() }), defaults: { v: '' } });
    settings.registerNamespace({ scope: 'user', name: 'b', schema: z.object({ v: z.string() }), defaults: { v: '' } });
    const first = await settings.patchSystem('versioned', { n: 1 }, { actorUserId: LOCAL_USER_ID, ifMatchVersion: 0 });
    expect(first.version).toBe(1);
    await expect(settings.patchSystem('versioned', { n: 2 }, { actorUserId: LOCAL_USER_ID, ifMatchVersion: 0 })).rejects.toThrow(/version 1/);
    const read = await settings.readSystem<{ n: number }>('versioned', { withUpdatedBy: true });
    expect(read).toMatchObject({ value: { n: 1 }, version: 1, updatedBy: { id: LOCAL_USER_ID } });
    await settings.patchUser(LOCAL_USER_ID, 'a', { v: 'one' });
    await settings.patchUser(LOCAL_USER_ID, 'b', { v: 'two' });
    expect(await settings.readUser(LOCAL_USER_ID, 'a')).toEqual({ v: 'one' });
    expect(await settings.readUser(LOCAL_USER_ID, 'b')).toEqual({ v: 'two' });
  });

  it('refuses a patch the schema rejects without writing it', async () => {
    const settings = new PgSettings(db.prisma);
    settings.registerNamespace({ scope: 'system', name: 'strict', schema: z.object({ n: z.number().int() }), defaults: { n: 0 } });
    await expect(settings.patchSystem('strict', { n: 1.5 }, { actorUserId: LOCAL_USER_ID })).rejects.toThrow();
    expect((await settings.readSystem('strict')).version).toBe(0);
  });
});
