import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { archsOf } from '../../scripts/dist.mjs';
import { checksums, gate, mergeUpdateInfo } from '../../scripts/release-files.mjs';

// =============================================================================
// The release job's file work (marinoscar/kvox#587)
// =============================================================================

const ARM = `version: 0.1.0
files:
  - url: KVox-0.1.0-mac-arm64.zip
    sha512: AAA
    size: 10
  - url: KVox-0.1.0-mac-arm64.dmg
    sha512: BBB
    size: 11
path: KVox-0.1.0-mac-arm64.zip
sha512: AAA
releaseDate: '2026-10-17T00:00:00.000Z'
`;
const INTEL = ARM.replace(/arm64/g, 'x64').replace(/AAA/g, 'CCC').replace(/BBB/g, 'DDD');

describe('mergeUpdateInfo', () => {
  it('lists both architectures in one latest-mac.yml', () => {
    const merged = mergeUpdateInfo([ARM, INTEL]);
    expect(merged).toBe(`version: 0.1.0
files:
  - url: KVox-0.1.0-mac-arm64.zip
    sha512: AAA
    size: 10
  - url: KVox-0.1.0-mac-arm64.dmg
    sha512: BBB
    size: 11
  - url: KVox-0.1.0-mac-x64.zip
    sha512: CCC
    size: 10
  - url: KVox-0.1.0-mac-x64.dmg
    sha512: DDD
    size: 11
path: KVox-0.1.0-mac-arm64.zip
sha512: AAA
releaseDate: '2026-10-17T00:00:00.000Z'
`);
  });

  it('refuses parts of different versions', () => {
    expect(() => mergeUpdateInfo([ARM, INTEL.replace('version: 0.1.0', 'version: 0.1.1')])).toThrow(/disagree/);
  });
});

describe('checksums', () => {
  let dir: string | undefined;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('writes sha256sum -c lines for every file but itself', () => {
    dir = mkdtempSync(join(tmpdir(), 'kvox-sums-'));
    writeFileSync(join(dir, 'b.deb'), 'deb');
    writeFileSync(join(dir, 'a.exe'), 'exe');
    writeFileSync(join(dir, 'SHA256SUMS'), 'old');
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    expect(checksums(dir)).toBe(`${sha('exe')}  a.exe\n${sha('deb')}  b.deb\n`);
  });
});

describe('gate', () => {
  const win = { platform: 'win32', arch: 'x64+arm64', windowsSigned: true, macSigned: false, macNotarized: false };
  const mac = (arch: string, notarized = true) => ({ platform: 'darwin', arch, windowsSigned: false, macSigned: true, macNotarized: notarized });
  const linux = { platform: 'linux', arch: 'x64', windowsSigned: false, macSigned: false, macNotarized: false };

  it('publishes only when Windows is signed and every Mac build is signed and notarized', () => {
    expect(gate([win, mac('arm64'), mac('x64'), linux])).toEqual({ publish: true, reasons: [] });
    expect(gate([{ ...win, windowsSigned: false }, mac('arm64'), mac('x64'), linux]).reasons).toEqual(['Windows (x64+arm64) is not signed']);
    expect(gate([win, mac('arm64'), mac('x64', false), linux]).reasons).toEqual(['macOS (x64) is not notarized']);
    expect(gate([linux]).publish).toBe(false);
  });
});

describe('archsOf', () => {
  it('reads the architectures of an electron-builder command line', () => {
    expect(archsOf(['--win', '--x64', '--arm64'])).toEqual(['x64', 'arm64']);
    expect(archsOf(['--linux'], 'x64')).toEqual(['x64']);
  });
});
