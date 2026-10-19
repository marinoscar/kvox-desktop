import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { entrySegments, extractCopilotRuntimeTgz, UnsafeArchiveError } from '../../src/server/ai/copilot-runtime-extract';
import { runtimePackage, tar, tgz, type TarEntry } from '../support/tgz';

// =============================================================================
// The Copilot runtime archive extractor (marinoscar/kvox-desktop#32)
// =============================================================================
//
// The archive was verified against a pinned SHA-256 before it reaches the extractor,
// but the extractor still treats it as hostile: crafted archives must be refused
// and must not write a byte outside the destination. Crafted with tests/support/tgz.
// =============================================================================

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A sandbox: `<root>/out` is the destination, `<root>` must stay otherwise untouched. */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'kvox-extract-'));
  roots.push(root);
  const out = join(root, 'out');
  mkdirSync(out);
  const archive = join(root, 'a.tgz');
  return { root, out, archive };
}

async function extract(entries: TarEntry[] | Buffer, options: { launcher?: string; limits?: Parameters<typeof extractCopilotRuntimeTgz>[2]['limits'] } = {}) {
  const s = sandbox();
  writeFileSync(s.archive, Buffer.isBuffer(entries) ? entries : tgz(entries));
  const run = () =>
    extractCopilotRuntimeTgz(s.archive, s.out, { launcher: options.launcher ?? 'prebuilds/linux-x64/copilot-runtime', ...(options.limits ? { limits: options.limits } : {}) });
  return { ...s, run };
}

/** What the sandbox holds besides `out` and the archive: nothing may appear there. */
function strays(root: string): string[] {
  return readdirSync(root).filter((name) => name !== 'out' && name !== 'a.tgz');
}

const OK = runtimePackage().entries;

describe('extractCopilotRuntimeTgz', () => {
  it('unpacks the package with its layout (package/ stripped), returns the launcher and makes it executable', async () => {
    const s = await extract(OK);
    const launcher = await s.run();
    expect(launcher).toBe(join(s.out, 'prebuilds', 'linux-x64', 'copilot-runtime'));
    expect(readFileSync(launcher, 'utf8')).toBe('#!launcher\n');
    // The launcher's sibling and the package's other folders stay beside it (the launcher needs them).
    expect(statSync(join(s.out, 'prebuilds', 'linux-x64', 'runtime.node')).size).toBe(4096);
    expect(readFileSync(join(s.out, 'builtin', 'skill.md'), 'utf8')).toBe('# skill\n');
    expect(existsSync(join(s.out, 'package'))).toBe(false);
    if (process.platform !== 'win32') {
      expect(statSync(launcher).mode & 0o777).toBe(0o755);
      // setuid never survives; an executable helper stays executable, a plain file does not become one.
      expect(statSync(join(s.out, 'ripgrep', 'rg')).mode & 0o7777).toBe(0o755 & ~process.umask());
      expect(statSync(join(s.out, 'package.json')).mode & 0o111).toBe(0);
    }
    expect(strays(s.root)).toEqual([]);
  });

  it('makes a launcher executable even when the archive stored it 0644', async () => {
    const entries = OK.map((e) => (e.name.endsWith('/copilot-runtime') ? { ...e, mode: 0o644 } : e));
    const s = await extract(entries);
    const launcher = await s.run();
    if (process.platform !== 'win32') expect(statSync(launcher).mode & 0o777).toBe(0o755);
  });

  it('reads a GNU long name and a pax path like a short one', async () => {
    const deep = `package/${'d'.repeat(60)}/${'e'.repeat(60)}/file.txt`;
    const s = await extract([
      ...OK,
      { name: '././@LongLink', type: 'L', body: `${deep}\0` },
      { name: 'ignored-short-name', body: 'long' },
      { name: 'PaxHeader', type: 'x', body: paxRecord('path', 'package/pax/dir/file.txt') },
      { name: 'ignored-too', body: 'pax' },
    ]);
    await s.run();
    expect(readFileSync(join(s.out, 'd'.repeat(60), 'e'.repeat(60), 'file.txt'), 'utf8')).toBe('long');
    expect(readFileSync(join(s.out, 'pax', 'dir', 'file.txt'), 'utf8')).toBe('pax');
  });

  describe('refuses a hostile archive and writes nothing outside the destination', () => {
    const refused: Array<[string, TarEntry[]]> = [
      ['a ".." segment climbing out', [{ name: 'package/../escape.txt', body: 'x' }]],
      ['a ".." segment in the middle', [{ name: 'package/a/../../escape.txt', body: 'x' }]],
      ['a leading ".."', [{ name: '../escape.txt', body: 'x' }]],
      ['an absolute path', [{ name: '/tmp/escape.txt', body: 'x' }]],
      ['an absolute path under package', [{ name: '/package/x', body: 'x' }]],
      ['a Windows drive path', [{ name: 'C:/Windows/escape.txt', body: 'x' }]],
      ['a backslash path', [{ name: 'package\\..\\escape.txt', body: 'x' }]],
      ['a root that is not package/', [{ name: 'other/x', body: 'x' }]],
      ['a file named package', [{ name: 'package', body: 'x' }]],
      ['a symbolic link', [{ name: 'package/link', type: '2', linkname: '/etc' }]],
      ['a symbolic link out of the folder', [{ name: 'package/link', type: '2', linkname: '../../..' }]],
      ['a symbolic link and a file written through it', [{ name: 'package/link', type: '2', linkname: '..' }, { name: 'package/link/escape.txt', body: 'x' }]],
      ['a hard link', [{ name: 'package/hard', type: '1', linkname: 'package/prebuilds/linux-x64/copilot-runtime' }]],
      ['a device entry', [{ name: 'package/dev', type: '3' }]],
      ['a directory with a body', [{ name: 'package/d', type: '5', body: 'x' }]],
    ];
    for (const [label, evil] of refused) {
      it(`refuses ${label}`, async () => {
        const s = await extract([...OK.slice(0, 3), ...evil]);
        await expect(s.run()).rejects.toBeInstanceOf(UnsafeArchiveError);
        expect(strays(s.root)).toEqual([]);
        expect(existsSync(join(s.root, 'escape.txt'))).toBe(false);
      });
    }

    it('refuses a ".." path that arrives through a GNU long name or a pax header', async () => {
      for (const meta of [
        { name: '././@LongLink', type: 'L', body: 'package/../../escape.txt\0' },
        { name: 'PaxHeader', type: 'x', body: paxRecord('path', 'package/../../escape.txt') },
      ]) {
        const s = await extract([...OK.slice(0, 3), meta, { name: 'innocent', body: 'x' }]);
        await expect(s.run()).rejects.toBeInstanceOf(UnsafeArchiveError);
        expect(strays(s.root)).toEqual([]);
      }
    });

    it('does not write through a symbolic link that already exists in the destination', async () => {
      const s = await extract([...OK, { name: 'package/planted/escape.txt', body: 'x' }]);
      const outside = join(s.root, 'outside');
      mkdirSync(outside);
      symlinkSync(outside, join(s.out, 'planted'));
      await expect(s.run()).rejects.toThrow();
      expect(readdirSync(outside)).toEqual([]);
    });

    it('refuses a duplicate entry instead of overwriting', async () => {
      const s = await extract([...OK, { name: 'package/builtin/skill.md', body: 'second' }]);
      await expect(s.run()).rejects.toBeInstanceOf(UnsafeArchiveError);
    });
  });

  describe('limits and integrity', () => {
    it('refuses an entry over the per-entry limit before writing it', async () => {
      const s = await extract([...OK, { name: 'package/big.bin', body: Buffer.alloc(2048) }], { limits: { maxEntryBytes: 1024 } });
      await expect(s.run()).rejects.toThrow(/size limit/);
      expect(existsSync(join(s.out, 'big.bin'))).toBe(false);
    });

    it('refuses an archive over the total limit', async () => {
      const s = await extract(OK, { limits: { maxTotalBytes: 4000 } });
      await expect(s.run()).rejects.toThrow(/total size limit/);
    });

    it('refuses an entry count over the limit', async () => {
      const many: TarEntry[] = Array.from({ length: 30 }, (_, i) => ({ name: `package/f${i}`, body: 'x' }));
      const s = await extract([...OK, ...many], { limits: { maxEntries: 20 } });
      await expect(s.run()).rejects.toThrow(/too many entries/);
    });

    it('does not trust a header that lies about its size (a short body is a truncated archive)', async () => {
      const s = await extract([...OK.slice(0, 3), { name: 'package/liar', body: 'abc', declaredSize: 10_000_000 }]);
      await expect(s.run()).rejects.toThrow(/truncated/);
    });

    it('refuses a corrupt header checksum', async () => {
      const s = await extract([...OK.slice(0, 3), { name: 'package/bad', body: 'x', corrupt: true }]);
      await expect(s.run()).rejects.toThrow(/corrupt header/);
    });

    it('refuses a truncated archive and a file that is not gzip', async () => {
      const whole = tar(OK);
      const cut = await extract(gzipSync(whole.subarray(0, 512 + 100)));
      await expect(cut.run()).rejects.toThrow();
      const junk = await extract(Buffer.from('this is not a gzip file'));
      await expect(junk.run()).rejects.toThrow();
    });

    it('refuses an archive without the launcher, and a launcher that is a directory', async () => {
      const without = await extract(OK.filter((e) => !e.name.endsWith('/copilot-runtime')));
      await expect(without.run()).rejects.toThrow(/launcher/);
      const dir = await extract([...OK.filter((e) => !e.name.endsWith('/copilot-runtime')), { name: 'package/prebuilds/linux-x64/copilot-runtime/', type: '5' }]);
      await expect(dir.run()).rejects.toThrow(/launcher/);
    });

    it('refuses an unsafe launcher path in the options', async () => {
      const s = await extract(OK, { launcher: '../escape' });
      await expect(s.run()).rejects.toBeInstanceOf(UnsafeArchiveError);
    });

    it('leaves nothing behind that is a link, even in a refused archive', async () => {
      const s = await extract([...OK, { name: 'package/link', type: '2', linkname: '/' }]);
      await expect(s.run()).rejects.toThrow();
      expect(existsSync(join(s.out, 'link'))).toBe(false);
      expect(() => lstatSync(join(s.out, 'link'))).toThrow();
    });
  });
});

describe('entrySegments', () => {
  it('strips the package root and refuses unsafe names', () => {
    expect(entrySegments('package/a/b.txt')).toEqual(['a', 'b.txt']);
    expect(entrySegments('./package/./a//b')).toEqual(['a', 'b']);
    expect(entrySegments('package/')).toBeNull();
    for (const bad of ['', '/abs', 'package/../x', 'x/y', 'package/a\\b', 'D:\\x', 'package/a\0b']) {
      expect(() => entrySegments(bad), bad).toThrow(UnsafeArchiveError);
    }
  });
});

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body);
  return `${length}${body}`;
}
