import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NOTE_IMPORT_EXTENSIONS } from '@marinoscar/kvox-contract/notes';

import { FILES_CHANNELS, FILES_ENUMERATE_PAGE_SIZE, type FilesResult } from '../../src/shared/protocol';
import { removeQuietly } from './support/database';

// The IPC handlers are registered on a fake `ipcMain`; the dialog answers what a test sets (vi.mock is hoisted).
const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  dialogPaths: [] as string[],
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => electron.handlers.set(channel, handler) },
  dialog: { showOpenDialog: async () => ({ canceled: electron.dialogPaths.length === 0, filePaths: electron.dialogPaths }) },
}));

import { FilesService, registerFilesIpc } from '../../src/main/files/ipc';
import { FilesError, resolveInside } from '../../src/main/files/paths';
import { FolderRegistry } from '../../src/main/files/registry';
import { extensionSet, hashFile, readFileInside, walkFolder } from '../../src/main/files/walk';
import { FolderWatchers, type WatchFunction } from '../../src/main/files/watcher';

// =============================================================================
// The main process's file port (marinoscar/kvox-desktop#47)
// =============================================================================
//
// What the note libraries read through: a folder registry in settings.json, a
// walk that keeps only importable files (no hidden entries, no node_modules,
// no symbolic links), a streaming hash, a bounded read, a debounced watcher,
// and IPC handlers that refuse any path outside the picked folder and never
// answer an absolute path.
// =============================================================================

let dir: string;
let root: string;

function write(relative: string, content: string | Buffer = 'x'): void {
  const path = join(root, ...relative.split('/'));
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

async function collect(extensions: readonly string[] = NOTE_IMPORT_EXTENSIONS): Promise<string[]> {
  const paths: string[] = [];
  for await (const entry of walkFolder(root, extensionSet(extensions))) paths.push(entry.path);
  return paths.sort();
}

async function call<T>(channel: string, ...args: unknown[]): Promise<FilesResult<T>> {
  const handler = electron.handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return (await handler({}, ...args)) as FilesResult<T>;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kvox-files-'));
  root = join(dir, 'Notes');
  mkdirSync(root);
});

afterEach(() => {
  vi.useRealTimers();
  removeQuietly(dir);
});

describe('paths inside a folder', () => {
  it('refuses traversal, absolute paths, drive letters and control characters', async () => {
    write('inside.md');
    writeFileSync(join(dir, 'secret.md'), 'secret');
    for (const bad of ['../secret.md', 'a/../../secret.md', '/etc/passwd', 'C:\\Windows\\win.ini', 'C:/x.md', '..', '', 'a\u0000.md', 42, null]) {
      await expect(resolveInside(root, bad), String(bad)).rejects.toBeInstanceOf(FilesError);
    }
    await expect(resolveInside(root, 'inside.md')).resolves.toMatchObject({ path: 'inside.md' });
    // Backslashes and dot segments normalise (the contract's normalizeLibraryPath).
    write('sub/deep.md');
    await expect(resolveInside(root, 'sub\\.\\deep.md')).resolves.toMatchObject({ path: 'sub/deep.md' });
  });

  it('refuses a symbolic link inside the folder that points outside it', async () => {
    writeFileSync(join(dir, 'secret.md'), 'secret');
    symlinkSync(join(dir, 'secret.md'), join(root, 'link.md'));
    await expect(readFileInside(root, 'link.md')).rejects.toMatchObject({ code: 'not_found' });
    await expect(hashFile(root, 'link.md')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('walkFolder', () => {
  it('yields only importable files, skipping hidden entries, node_modules and symbolic links', async () => {
    for (const name of ['a.md', 'b.txt', 'c.pdf', 'd.docx', 'e.pptx', 'f.markdown', 'sub/deep/G.MD']) write(name);
    for (const name of ['image.png', 'data.json', 'noext', '.hidden.md', '.git/config.md', 'node_modules/pkg/readme.md', 'sub/.cache/x.txt']) write(name);
    mkdirSync(join(dir, 'outside'));
    writeFileSync(join(dir, 'outside', 'o.md'), 'o');
    symlinkSync(join(dir, 'outside'), join(root, 'linked-dir'));
    symlinkSync(join(root, 'a.md'), join(root, 'linked-file.md'));

    expect(await collect()).toEqual(['a.md', 'b.txt', 'c.pdf', 'd.docx', 'e.pptx', 'f.markdown', 'sub/deep/G.MD']);
    expect(await collect(['.PDF'])).toEqual(['c.pdf']);
  });

  it('reports size and mtime', async () => {
    write('a.md', 'hello');
    const entries = [];
    for await (const entry of walkFolder(root, extensionSet(['md']))) entries.push(entry);
    expect(entries).toEqual([{ path: 'a.md', size: 5, mtime: expect.any(Number) }]);
    expect(Number.isInteger(entries[0]!.mtime)).toBe(true);
  });

  it('refuses a folder that is gone', async () => {
    const walk = walkFolder(join(dir, 'missing'), extensionSet(['md']));
    await expect(walk.next()).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('hash and read', () => {
  it('hashes a file with SHA-256, streamed', async () => {
    const content = Buffer.alloc(3 * 1024 * 1024 + 7, 'k');
    write('big.pdf', content);
    expect(await hashFile(root, 'big.pdf')).toBe(createHash('sha256').update(content).digest('hex'));
  });

  it('reads a file as an ArrayBuffer of exactly its bytes, and refuses one over the cap', async () => {
    write('a.md', '# Title');
    const bytes = await readFileInside(root, 'a.md');
    expect(bytes).toBeInstanceOf(ArrayBuffer);
    expect(Buffer.from(bytes).toString()).toBe('# Title');
    await expect(readFileInside(root, 'a.md', 3)).rejects.toMatchObject({ code: 'too_large' });
    await expect(readFileInside(root, 'missing.md')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('FolderWatchers', () => {
  it('sends the changed paths once the folder has been quiet for 2 s', () => {
    vi.useFakeTimers();
    let listener: ((event: string, filename: string | Buffer | null) => void) | undefined;
    const close = vi.fn();
    const watch: WatchFunction = (_path, options, callback) => {
      expect(options).toMatchObject({ recursive: true });
      listener = callback;
      return { close, on: () => undefined as never } as never;
    };
    const onChange = vi.fn();
    const watchers = new FolderWatchers({ onChange, watch });
    watchers.watch('f1', root);
    watchers.watch('f1', root); // idempotent

    listener!('change', 'a.md');
    vi.advanceTimersByTime(1500);
    listener!('rename', 'sub\\b.md');
    listener!('change', '.git/index');
    listener!('change', 'a.md');
    vi.advanceTimersByTime(1999);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('f1', ['a.md', 'sub/b.md']);

    // Only hidden changes: nothing is sent.
    listener!('change', '.DS_Store');
    vi.advanceTimersByTime(5000);
    expect(onChange).toHaveBeenCalledTimes(1);

    watchers.unwatch('f1');
    expect(close).toHaveBeenCalledTimes(1);
    expect(watchers.ids()).toEqual([]);
  });

  it('watches a real folder (recursive fs.watch) and reports a new file', async () => {
    const changes: string[][] = [];
    const watchers = new FolderWatchers({ onChange: (_id, paths) => changes.push(paths), debounceMs: 100 });
    watchers.watch('f1', root);
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      write('sub/new.md', 'new');
      for (let attempt = 0; attempt < 50 && changes.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
      expect(changes.flat()).toContain('sub/new.md');
    } finally {
      watchers.closeAll();
    }
  });
});

describe('FolderRegistry', () => {
  it('keeps folders and bindings in settings.json, reuses a known folder, and forgets bindings with the folder', () => {
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ themeMode: 'dark' }));
    let n = 0;
    const registry = new FolderRegistry(settingsPath, () => `id-${(n += 1)}`);

    const ref = registry.add(root);
    expect(ref).toEqual({ id: 'id-1', name: 'Notes' });
    expect(registry.add(join(root, '.'))).toEqual(ref);
    registry.bindLibrary('lib-1', ref.id);
    expect(registry.libraryFolder('lib-1')).toEqual(ref);
    expect(() => registry.bindLibrary('lib-2', 'nope')).toThrow(FilesError);
    expect(() => registry.libraryFolder('../x')).toThrow(FilesError);

    const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(saved.themeMode).toBe('dark');
    expect(saved.files).toEqual({ folders: { 'id-1': { path: root, name: 'Notes' } }, libraries: { 'lib-1': 'id-1' } });

    registry.forget(ref.id);
    expect(registry.list()).toEqual([]);
    expect(registry.libraryFolder('lib-1')).toBeNull();
  });
});

describe('the files:* IPC handlers', () => {
  let settingsPath: string;
  const sent: unknown[] = [];

  beforeEach(() => {
    electron.handlers.clear();
    electron.dialogPaths = [];
    sent.length = 0;
    settingsPath = join(dir, 'settings.json');
    registerFilesIpc({
      window: () => ({ isDestroyed: () => false, webContents: { send: (...args: unknown[]) => sent.push(args) } }) as never,
      settingsPath: () => settingsPath,
      log: () => undefined,
    });
  });

  it('registers every invoke channel of the protocol', () => {
    const invoke = Object.values(FILES_CHANNELS).filter((channel) => channel !== FILES_CHANNELS.changed);
    expect([...electron.handlers.keys()].sort()).toEqual([...invoke].sort());
  });

  it('picks, walks in pages, hashes, reads and binds, and never answers an absolute path', async () => {
    for (let i = 0; i < FILES_ENUMERATE_PAGE_SIZE + 20; i += 1) write(`many/n${i}.md`, `note ${i}`);
    write('photo.png');
    expect(await call(FILES_CHANNELS.pickFolder)).toEqual({ ok: true, value: null }); // cancelled
    electron.dialogPaths = [root];
    const picked = await call<{ id: string; name: string }>(FILES_CHANNELS.pickFolder);
    expect(picked).toMatchObject({ ok: true, value: { name: 'Notes' } });
    if (!picked.ok) return;
    const id = picked.value.id;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const started = await call<{ cursor: string }>(FILES_CHANNELS.enumerate, id, NOTE_IMPORT_EXTENSIONS);
    if (!started.ok) throw new Error('enumerate failed');
    const pages: Array<{ entries: Array<{ path: string }>; done: boolean }> = [];
    for (;;) {
      const page = await call<{ entries: Array<{ path: string }>; done: boolean }>(FILES_CHANNELS.enumerateNext, started.value.cursor);
      if (!page.ok) throw new Error('page failed');
      pages.push(page.value);
      if (page.value.done) break;
    }
    expect(pages[0]!.entries).toHaveLength(FILES_ENUMERATE_PAGE_SIZE);
    expect(pages.flatMap((page) => page.entries)).toHaveLength(FILES_ENUMERATE_PAGE_SIZE + 20);
    // The cursor is released after the last page.
    expect(await call(FILES_CHANNELS.enumerateNext, started.value.cursor)).toMatchObject({ ok: false, code: 'unknown_folder' });

    expect(await call(FILES_CHANNELS.hash, id, 'many/n1.md')).toEqual({ ok: true, value: createHash('sha256').update('note 1').digest('hex') });
    const read = await call<ArrayBuffer>(FILES_CHANNELS.read, id, 'many/n2.md');
    expect(read.ok && Buffer.from(read.value).toString()).toBe('note 2');

    expect(await call(FILES_CHANNELS.setLibraryFolder, 'lib-1', id)).toEqual({ ok: true, value: null });
    expect(await call(FILES_CHANNELS.getLibraryFolder, 'lib-1')).toEqual({ ok: true, value: { id, name: 'Notes' } });
    expect(await call(FILES_CHANNELS.listFolders)).toEqual({ ok: true, value: [{ id, name: 'Notes' }] });

    const answers = JSON.stringify([picked, pages, await call(FILES_CHANNELS.listFolders)]);
    expect(answers).not.toContain(dir);
  });

  it('refuses unknown folders, bad ids and paths outside the folder', async () => {
    writeFileSync(join(dir, 'secret.md'), 'secret');
    electron.dialogPaths = [root];
    const picked = await call<{ id: string }>(FILES_CHANNELS.pickFolder);
    if (!picked.ok) throw new Error('pick failed');
    const id = picked.value.id;

    for (const path of ['../secret.md', '/etc/passwd', `${dir}/secret.md`, 'C:\\secret.md', 'a/../../secret.md']) {
      expect(await call(FILES_CHANNELS.read, id, path), path).toMatchObject({ ok: false, code: 'not_found' });
      expect(await call(FILES_CHANNELS.hash, id, path), path).toMatchObject({ ok: false, code: 'not_found' });
    }
    expect(await call(FILES_CHANNELS.read, 'not-a-folder', 'a.md')).toMatchObject({ ok: false, code: 'unknown_folder' });
    expect(await call(FILES_CHANNELS.read, { id }, 'a.md')).toMatchObject({ ok: false, code: 'unknown_folder' });
    expect(await call(FILES_CHANNELS.enumerate, id, 'md')).toMatchObject({ ok: false });
    expect(await call(FILES_CHANNELS.enumerate, '../x', ['md'])).toMatchObject({ ok: false, code: 'unknown_folder' });
    expect(await call(FILES_CHANNELS.setLibraryFolder, 'lib/../x', id)).toMatchObject({ ok: false });
    expect(await call(FILES_CHANNELS.setLibraryFolder, 'lib-1', 'unknown')).toMatchObject({ ok: false, code: 'unknown_folder' });
    expect(await call(FILES_CHANNELS.watch, 'unknown')).toMatchObject({ ok: false, code: 'unknown_folder' });

    expect(await call(FILES_CHANNELS.forgetFolder, id)).toEqual({ ok: true, value: null });
    expect(await call(FILES_CHANNELS.read, id, 'a.md')).toMatchObject({ ok: false, code: 'unknown_folder' });
  });

  it('cancels a walk early', async () => {
    write('a.md');
    const service = new FilesService({ settingsPath: join(dir, 'other.json'), onChange: () => undefined });
    const ref = service.registry.add(root);
    const { cursor } = service.enumerate(ref.id, ['md']);
    await service.enumerateCancel(cursor);
    await expect(service.enumerateNext(cursor)).rejects.toMatchObject({ code: 'unknown_folder' });
    service.close();
  });
});
