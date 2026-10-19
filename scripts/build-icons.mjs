#!/usr/bin/env node
// =============================================================================
// The application icons, generated from the KVox mark (marinoscar/kvox-desktop#20)
// =============================================================================
//
//   npm run icons                  writes every icon below
//   npm run icons -- --check       writes nothing; exits 1 when a committed icon
//                                  differs from a regeneration (CI)
//   npm run icons -- --source <f>  use another mark.svg (development only; the
//                                  committed icons must come from the package)
//
// The SOURCE is `@marinoscar/kvox-web/brand/assets/mark.svg`, resolved from
// node_modules. The mark is never redrawn here and no icon is copied by hand:
// every size is rasterized from the vector, so a 16 px icon is drawn at 16 px
// (a downscale of a 1024 px bitmap is what makes small icons muddy).
//
//   build/icon.ico                        16 24 32 48 64 128 256 (PNG-compressed)
//   build/icon.icns                       16 32 64 128 256 512 1024, plus the @2x entries
//   build/linux/icon.png                  512 (the window icon, also packed as a resource)
//   build/linux/icons/<n>x<n>.png         16 24 32 48 64 128 256 512 (desktop-entry sizes)
//
// The rasterizer is @resvg/resvg-js (pinned; a prebuilt native module, no
// network at run time). The two containers are written here: an ICO and an ICNS
// are a header plus PNG payloads, so no further dependency is needed.
//
// Importing this module runs nothing.
// =============================================================================

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Resvg } from '@resvg/resvg-js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The package export that carries the mark. */
export const MARK_SPECIFIER = '@marinoscar/kvox-web/brand/assets/mark.svg';

/** The sizes of `build/icon.ico`. */
export const ICO_SIZES = Object.freeze([16, 24, 32, 48, 64, 128, 256]);

/** The sizes of `build/linux/icons`. */
export const LINUX_SIZES = Object.freeze([16, 24, 32, 48, 64, 128, 256, 512]);

/**
 * The entries of `build/icon.icns`: the OSType and the pixel size of its PNG.
 * `ic11`..`ic14` are the @2x (retina) entries of 16, 32, 128 and 256 points.
 */
export const ICNS_ENTRIES = Object.freeze([
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512],
]);

/** The colours of the real mark; a file without all three is not it. */
export const MARK_COLOURS = Object.freeze(['#4f46e5', '#ffffff', '#fbbf24']);

/** The folder the generated Linux sizes live in, relative to the repository root. */
export const LINUX_ICON_DIR = 'build/linux/icons';

/** Resolves the mark from the installed package; `null` when the installed version has no brand export. */
export function resolveMark(from = import.meta.url) {
  try {
    return createRequire(from).resolve(MARK_SPECIFIER);
  } catch {
    return null;
  }
}

/** Throws unless the SVG is the KVox mark (an indigo plate, a white K, amber bars). */
export function assertKvoxMark(svg, label = 'mark.svg') {
  const lower = svg.toLowerCase();
  const missing = MARK_COLOURS.filter((colour) => !lower.includes(colour));
  if (missing.length > 0) {
    throw new Error(`${label} is not the KVox mark (missing ${missing.join(', ')}); refusing to generate icons from it.`);
  }
}

/** One square PNG of the vector at exactly `size` pixels. */
export function rasterize(svg, size) {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  const png = resvg.render();
  if (png.width !== size || png.height !== size) throw new Error(`The mark rendered ${png.width}x${png.height}, not ${size}x${size}.`);
  return png.asPng();
}

/** An ICO whose images are PNGs (Windows Vista and later), the 256 entry included. */
export function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach(({ size, png }, index) => {
    const at = index * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, at); // 0 means 256
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1);
    directory.writeUInt8(0, at + 2); // palette
    directory.writeUInt8(0, at + 3);
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, directory, ...images.map(({ png }) => png)]);
}

/** An ICNS of PNG entries. `entries` are `{ type, png }`. */
export function buildIcns(entries) {
  const chunks = entries.map(({ type, png }) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const total = 8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(total, 4);
  return Buffer.concat([head, ...chunks]);
}

/** Every generated file, as a map of repository-relative path (forward slashes) to bytes. */
export function generateIcons(svg) {
  assertKvoxMark(svg);
  const sizes = new Set([...ICO_SIZES, ...LINUX_SIZES, ...ICNS_ENTRIES.map(([, size]) => size)]);
  const png = new Map([...sizes].map((size) => [size, rasterize(svg, size)]));
  const out = new Map();
  out.set('build/icon.ico', buildIco(ICO_SIZES.map((size) => ({ size, png: png.get(size) }))));
  out.set('build/icon.icns', buildIcns(ICNS_ENTRIES.map(([type, size]) => ({ type, png: png.get(size) }))));
  out.set('build/linux/icon.png', png.get(512));
  for (const size of LINUX_SIZES) out.set(`${LINUX_ICON_DIR}/${size}x${size}.png`, png.get(size));
  return out;
}

/** What differs between a generation and the files under `root`: `{ missing, changed, stale }`. */
export function compareIcons(generated, root = ROOT) {
  const missing = [];
  const changed = [];
  for (const [path, bytes] of generated) {
    const file = join(root, path);
    if (!existsSync(file)) missing.push(path);
    else if (!readFileSync(file).equals(bytes)) changed.push(path);
  }
  const dir = join(root, LINUX_ICON_DIR);
  const stale = existsSync(dir) ? readdirSync(dir).map((name) => `${LINUX_ICON_DIR}/${name}`).filter((path) => !generated.has(path)) : [];
  return { missing, changed, stale };
}

/** Writes the generation under `root` and removes sizes that are no longer generated. */
export function writeIcons(generated, root = ROOT) {
  for (const [path, bytes] of generated) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
  for (const path of compareIcons(generated, root).stale) rmSync(join(root, path));
}

function main(argv) {
  const check = argv.includes('--check');
  const flag = argv.indexOf('--source');
  const source = flag >= 0 ? resolve(argv[flag + 1] ?? '') : resolveMark();
  if (!source || !existsSync(source)) {
    console.error(
      `icons: ${MARK_SPECIFIER} is not installed. Install a @marinoscar/kvox-web version that exports the brand assets ` +
        '(marinoscar/kvox#628); the icons are generated from that file and never drawn here.',
    );
    return 1;
  }
  const generated = generateIcons(readFileSync(source, 'utf8'));
  if (check) {
    const { missing, changed, stale } = compareIcons(generated);
    const problems = [...missing.map((p) => `missing  ${p}`), ...changed.map((p) => `differs  ${p}`), ...stale.map((p) => `stale    ${p}`)];
    if (problems.length > 0) {
      console.error(`icons: the committed icons do not match ${MARK_SPECIFIER}:\n  ${problems.join('\n  ')}\nRun \`npm run icons\` and commit the result.`);
      return 1;
    }
    console.log(`icons: ${generated.size} files match ${MARK_SPECIFIER}.`);
    return 0;
  }
  writeIcons(generated);
  console.log(`icons: wrote ${generated.size} files from ${source}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
