import { describe, expect, it, vi } from 'vitest';

import { KvoxFileAccessError } from '@marinoscar/kvox-web/core/headless';

import { createDesktopFileAccess } from '../../src/renderer/src/files';
import { createSerialQueue } from '../../src/renderer/src/libraries/syncQueue';
import { syncStatusText } from '../../src/renderer/src/libraries/LibrarySyncController';
import type { FilesChangedEvent, FilesEntry, FilesResult, KvoxDesktopFilesBridge } from '../../src/shared/protocol';

// =============================================================================
// The renderer's file port and the sync queue (marinoscar/kvox-desktop#47)
// =============================================================================
//
// `createDesktopFileAccess` is the `KvoxFileAccessPort` kvox-web reads folders
// through on Desktop: it pages a walk over IPC (and releases it when the caller
// stops early), maps the main process's codes to `KvoxFileAccessError`, fans
// one watch subscription out to several listeners, and tells the sync
// controller when a binding changed. The queue runs one sync at a time.
// =============================================================================

const ok = <T,>(value: T): FilesResult<T> => ({ ok: true, value });

function fakeBridge(entries: FilesEntry[], pageSize = 2) {
  let changed: ((event: FilesChangedEvent) => void) | undefined;
  const cursors = new Map<string, number>();
  const bridge = {
    pickFolder: vi.fn(async () => ok({ id: 'f1', name: 'Notes' })),
    listFolders: vi.fn(async () => ok([{ id: 'f1', name: 'Notes' }])),
    forgetFolder: vi.fn(async () => ok(null)),
    enumerate: vi.fn(async (folderId: string) => {
      if (folderId !== 'f1') return { ok: false as const, code: 'unknown_folder' as const, message: 'Unknown folder.' };
      cursors.set('c1', 0);
      return ok({ cursor: 'c1' });
    }),
    enumerateNext: vi.fn(async (cursor: string) => {
      const at = cursors.get(cursor) ?? 0;
      const page = entries.slice(at, at + pageSize);
      cursors.set(cursor, at + pageSize);
      return ok({ entries: page, done: at + pageSize >= entries.length });
    }),
    enumerateCancel: vi.fn(async () => undefined),
    hash: vi.fn(async () => ok('ab'.repeat(32))),
    read: vi.fn(async (_id: string, path: string) =>
      path === 'big.pdf'
        ? ({ ok: false as const, code: 'too_large' as const, message: '"big.pdf" is larger than 25 MB.' })
        : ok(new TextEncoder().encode('# Hi').buffer as ArrayBuffer),
    ),
    getLibraryFolder: vi.fn(async () => ok({ id: 'f1', name: 'Notes' })),
    setLibraryFolder: vi.fn(async () => ok(null)),
    watch: vi.fn(async () => ok(null)),
    unwatch: vi.fn(async () => undefined),
    onChanged: vi.fn((handler: (event: FilesChangedEvent) => void) => {
      changed = handler;
      return () => {
        changed = undefined;
      };
    }),
  } satisfies KvoxDesktopFilesBridge;
  return { bridge, emit: (event: FilesChangedEvent) => changed?.(event) };
}

const ENTRIES: FilesEntry[] = ['a.md', 'b.pdf', 'sub/c.docx', 'd.pptx', 'e.txt'].map((path, i) => ({ path, size: i + 1, mtime: 1000 + i }));
const REF = { id: 'f1', name: 'Notes' };

describe('createDesktopFileAccess', () => {
  it('declares persistent folders, a watcher and hashing in the host', () => {
    expect(createDesktopFileAccess(fakeBridge([]).bridge).capabilities).toEqual({ persistentFolders: true, watch: true, hashInHost: true });
  });

  it('pages a walk through to the end without cancelling it', async () => {
    const { bridge } = fakeBridge(ENTRIES);
    const port = createDesktopFileAccess(bridge);
    const seen = [];
    for await (const entry of port.enumerate(REF, { extensions: ['md', 'pdf'] })) seen.push(entry);
    expect(seen).toEqual(ENTRIES);
    expect(bridge.enumerate).toHaveBeenCalledWith('f1', ['md', 'pdf']);
    expect(bridge.enumerateNext).toHaveBeenCalledTimes(3);
    expect(bridge.enumerateCancel).not.toHaveBeenCalled();
  });

  it('releases the walk when the caller stops early or aborts', async () => {
    const { bridge } = fakeBridge(ENTRIES);
    const port = createDesktopFileAccess(bridge);
    for await (const entry of port.enumerate(REF, { extensions: ['md'] })) {
      expect(entry.path).toBe('a.md');
      break;
    }
    expect(bridge.enumerateCancel).toHaveBeenCalledWith('c1');

    const abort = new AbortController();
    const walk = port.enumerate(REF, { extensions: ['md'], signal: abort.signal })[Symbol.asyncIterator]();
    await walk.next();
    abort.abort(new DOMException('stop', 'AbortError'));
    await expect(walk.next()).rejects.toMatchObject({ name: 'AbortError' });
    expect(bridge.enumerateCancel).toHaveBeenCalledTimes(2);
  });

  it('maps the main process codes to KvoxFileAccessError, and a read over the cap to a plain error', async () => {
    const { bridge } = fakeBridge(ENTRIES);
    const port = createDesktopFileAccess(bridge);
    const walk = port.enumerate({ id: 'gone', name: 'Old' }, { extensions: ['md'] })[Symbol.asyncIterator]();
    const error = await walk.next().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(KvoxFileAccessError);
    expect(error).toMatchObject({ code: 'unknown_folder' });

    await expect(port.read(REF, 'big.pdf')).rejects.toThrow(/larger than 25 MB/);
    const blob = await port.read(REF, 'a.md');
    expect(await blob.text()).toBe('# Hi');
    expect(await port.hash(REF, 'a.md')).toBe('ab'.repeat(32));
  });

  it('fans one main-process watch out to several listeners, and stops it after the last', () => {
    const { bridge, emit } = fakeBridge([]);
    const port = createDesktopFileAccess(bridge);
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = port.watch!(REF, first);
    const stopSecond = port.watch!(REF, second);
    expect(bridge.watch).toHaveBeenCalledTimes(1);

    emit({ folderId: 'f1', paths: ['a.md'] });
    emit({ folderId: 'other', paths: ['x.md'] });
    expect(first).toHaveBeenCalledWith(['a.md']);
    expect(second).toHaveBeenCalledTimes(1);

    stopFirst();
    expect(bridge.unwatch).not.toHaveBeenCalled();
    stopSecond();
    stopSecond();
    expect(bridge.unwatch).toHaveBeenCalledTimes(1);
  });

  it('tells the sync controller when a binding changes', async () => {
    const { bridge } = fakeBridge([]);
    const port = createDesktopFileAccess(bridge);
    const listener = vi.fn();
    const off = port.onBindingsChanged(listener);
    await port.setLibraryFolder('lib-1', REF);
    expect(bridge.setLibraryFolder).toHaveBeenCalledWith('lib-1', 'f1');
    await port.setLibraryFolder('lib-1', null);
    expect(bridge.setLibraryFolder).toHaveBeenLastCalledWith('lib-1', null);
    await port.forgetFolder(REF);
    expect(listener).toHaveBeenCalledTimes(3);
    off();
    await port.setLibraryFolder('lib-1', REF);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(await port.getLibraryFolder('lib-1')).toEqual(REF);
  });
});

describe('createSerialQueue', () => {
  it('runs one key at a time, queues a key once, and re-runs a key requested while it runs', async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    let running = 0;
    let maxRunning = 0;
    const queue = createSerialQueue(async (key) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      order.push(key);
      if (key === 'a' && order.length === 1) await new Promise<void>((resolve) => (release = resolve));
      running -= 1;
    });
    queue.enqueue('a');
    queue.enqueue('b');
    queue.enqueue('b');
    queue.enqueue('a'); // while a runs: once more afterwards
    release!();
    await queue.idle();
    expect(order).toEqual(['a', 'b', 'a']);
    expect(maxRunning).toBe(1);
  });

  it('survives a failing run and stops taking keys once closed', async () => {
    const order: string[] = [];
    const queue = createSerialQueue(async (key) => {
      order.push(key);
      if (key === 'bad') throw new Error('boom');
    });
    queue.enqueue('bad');
    queue.enqueue('good');
    await queue.idle();
    queue.close();
    queue.enqueue('late');
    await queue.idle();
    expect(order).toEqual(['bad', 'good']);
  });
});

describe('syncStatusText', () => {
  it('says what the sync is doing', () => {
    const base = { libraryId: 'l', name: 'Work' };
    const progress = (phase: 'enumerating' | 'hashing' | 'uploading', done: number, total: number) => ({
      phase,
      done,
      total,
      bytes: 0,
      totalBytes: 0,
      failed: [],
    });
    expect(syncStatusText(base)).toBe('Checking “Work”…');
    expect(syncStatusText({ ...base, progress: progress('uploading', 12, 40) })).toBe('Syncing notes… 12/40');
    expect(syncStatusText({ ...base, progress: progress('hashing', 1, 3) })).toBe('Checking “Work”… 1/3');
    expect(syncStatusText({ ...base, result: { batchId: 'b', uploaded: 1, failed: 0 } })).toBe('Synced 1 note from “Work”');
    expect(syncStatusText({ ...base, result: { batchId: 'b', uploaded: 3, failed: 2 } })).toBe('Synced 3 notes from “Work”; 2 failed');
    expect(syncStatusText({ ...base, error: 'The folder is gone.' })).toBe('Could not sync “Work”: The folder is gone.');
  });
});
