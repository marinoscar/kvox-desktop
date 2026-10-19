import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

// =============================================================================
// A tiny tar/.tgz WRITER for tests (marinoscar/kvox-desktop#32)
// =============================================================================
//
// Builds the real thing and the crafted archives the extractor must refuse
// (traversal, absolute paths, links, corrupt headers). Test-only.
// =============================================================================

export interface TarEntry {
  name: string;
  /** `0` file (default), `5` directory, `2` symlink, `1` hard link, `L` GNU long name, `x` pax header, `3` device. */
  type?: string;
  body?: Buffer | string;
  mode?: number;
  linkname?: string;
  /** Overrides the size written in the header (a lie about the body). */
  declaredSize?: number;
  /** Breaks the header checksum. */
  corrupt?: boolean;
}

function field(buffer: Buffer, value: string, offset: number, length: number): void {
  buffer.write(value, offset, Math.min(Buffer.byteLength(value), length), 'utf8');
}

function header(entry: TarEntry, body: Buffer): Buffer {
  const block = Buffer.alloc(512);
  const name = Buffer.from(entry.name);
  if (name.length <= 100) field(block, entry.name, 0, 100);
  else {
    // ustar prefix/name split at a slash.
    const cut = entry.name.lastIndexOf('/', 155);
    field(block, entry.name.slice(0, cut), 345, 155);
    field(block, entry.name.slice(cut + 1), 0, 100);
  }
  field(block, (entry.mode ?? (entry.type === '5' ? 0o755 : 0o644)).toString(8).padStart(7, '0'), 100, 8);
  field(block, '0000000', 108, 8);
  field(block, '0000000', 116, 8);
  field(block, (entry.declaredSize ?? body.length).toString(8).padStart(11, '0'), 124, 12);
  field(block, '00000000000', 136, 12);
  block.fill(0x20, 148, 156);
  block[156] = (entry.type ?? '0').charCodeAt(0);
  if (entry.linkname) field(block, entry.linkname, 157, 100);
  field(block, 'ustar', 257, 6);
  field(block, '00', 263, 2);
  let sum = 0;
  for (const byte of block) sum += byte;
  field(block, `${(entry.corrupt ? sum + 1 : sum).toString(8).padStart(6, '0')}\0 `, 148, 8);
  return block;
}

/** The uncompressed tar bytes. */
export function tar(entries: TarEntry[], options: { terminate?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body ?? '');
    parts.push(header(entry, body));
    if (body.length > 0) {
      parts.push(body, Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length));
    }
  }
  if (options.terminate !== false) parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** A `.tgz`. */
export function tgz(entries: TarEntry[], options: { terminate?: boolean } = {}): Buffer {
  return gzipSync(tar(entries, options));
}

export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** A believable runtime package for one platform: launcher beside runtime.node, plus a sibling folder and a helper binary. */
export function runtimePackage(platform = 'linux-x64'): { entries: TarEntry[]; launcher: string } {
  const exe = platform.startsWith('win32') ? 'copilot-runtime.exe' : 'copilot-runtime';
  const launcher = `prebuilds/${platform}/${exe}`;
  return {
    launcher,
    entries: [
      { name: 'package/', type: '5' },
      { name: 'package/package.json', body: JSON.stringify({ name: `@github/copilot-sdk-${platform}`, version: '1.0.22' }) },
      { name: `package/${launcher}`, body: '#!launcher\n', mode: 0o755 },
      { name: `package/prebuilds/${platform}/runtime.node`, body: Buffer.alloc(4096, 7), mode: 0o755 },
      { name: 'package/builtin/', type: '5' },
      { name: 'package/builtin/skill.md', body: '# skill\n' },
      { name: 'package/ripgrep/rg', body: 'rg', mode: 0o4755 },
    ],
  };
}
