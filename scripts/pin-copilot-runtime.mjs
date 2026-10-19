#!/usr/bin/env node
// =============================================================================
// Re-pins the Copilot runtime download (marinoscar/kvox-desktop#32)
// =============================================================================
//
// The Copilot runtime is the optional npm package `@github/copilot-sdk-<platform>` of the
// pinned `@github/copilot-sdk`. Nobody publishes a SHA-256 for it, so WE compute it: this
// script reads the SDK version from package.json, asks the registry for the platform
// packages the SDK lists in `optionalDependencies`, downloads each tarball, hashes it,
// cross-checks the registry's own sha512 `dist.integrity`, confirms the tarball holds the
// launcher beside its `runtime.node`, and writes `src/server/ai/copilot-runtime-sources.ts`.
//
//   node scripts/pin-copilot-runtime.mjs            # regenerate the table (downloads ~0.5 GB)
//   node scripts/pin-copilot-runtime.mjs --check    # exit 1 when the committed table is stale
//   node scripts/pin-copilot-runtime.mjs --dir <d>  # keep/reuse the downloads in <d>
//
// Run it after bumping `@github/copilot-sdk` in package.json, review the diff, commit the
// table. Archives are untrusted data: they are only hashed and their tar headers read, never
// extracted or executed here.
// =============================================================================

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';

const REGISTRY = 'https://registry.npmjs.org';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TABLE_PATH = join(root, 'src', 'server', 'ai', 'copilot-runtime-sources.ts');

const args = process.argv.slice(2);
const check = args.includes('--check');
const dirFlag = args.indexOf('--dir');
const keepDir = dirFlag >= 0 ? resolve(args[dirFlag + 1] ?? '') : undefined;

async function json(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${url} answered ${res.status}`);
  return res.json();
}

/** Streams a tarball to `file`, returning its size and digests. */
async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`GET ${url} answered ${res.status}`);
  const sha256 = createHash('sha256');
  const sha512 = createHash('sha512');
  let size = 0;
  await pipeline(
    Readable.fromWeb(res.body),
    async function* (source) {
      for await (const chunk of source) {
        sha256.update(chunk);
        sha512.update(chunk);
        size += chunk.length;
        yield chunk;
      }
    },
    createWriteStream(file),
  );
  return { size, sha256: sha256.digest('hex'), sha512: sha512.digest('base64') };
}

/** The regular-file entries (name -> size) of a .tgz, reading tar headers only. */
async function listTgz(file) {
  const entries = new Map();
  let buffered = Buffer.alloc(0);
  let skip = 0;
  let longName;
  for await (const chunk of createReadStream(file).pipe(createGunzip())) {
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      if (skip > 0) {
        const take = Math.min(skip, buffered.length);
        buffered = buffered.subarray(take);
        skip -= take;
        if (skip > 0) break;
      }
      if (buffered.length < 512) break;
      const header = buffered.subarray(0, 512);
      if (header.every((b) => b === 0)) return entries;
      const field = (from, length) => header.subarray(from, from + length).toString('utf8').replace(/\0.*$/s, '');
      const size = parseInt(field(124, 12).trim() || '0', 8);
      const type = field(156, 1) || '0';
      const prefix = field(345, 155);
      let name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
      longName = undefined;
      const padded = Math.ceil(size / 512) * 512;
      if (type === 'L') {
        // GNU long name: the entry body is the next entry's name.
        if (buffered.length < 512 + padded) break;
        longName = buffered.subarray(512, 512 + size).toString('utf8').replace(/\0.*$/s, '');
        buffered = buffered.subarray(512 + padded);
        continue;
      }
      if (type === '0' || type === '\0') entries.set(name, size);
      buffered = buffered.subarray(512);
      skip = padded;
    }
  }
  return entries;
}

async function main() {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const sdkVersion = pkg.dependencies?.['@github/copilot-sdk'];
  if (!/^\d+\.\d+\.\d+$/.test(sdkVersion ?? '')) {
    throw new Error(`package.json must pin @github/copilot-sdk to an exact version (found ${sdkVersion}).`);
  }
  const sdk = await json(`${REGISTRY}/@github/copilot-sdk/${sdkVersion}`);
  const runtimeVersion = sdk.copilotRuntime?.version ?? sdk.copilotCliVersion;
  if (!/^\d+\.\d+\.\d+$/.test(runtimeVersion ?? '')) throw new Error('The SDK package does not name its runtime version.');
  const prefix = '@github/copilot-sdk-';
  const platforms = Object.keys(sdk.optionalDependencies ?? {})
    .filter((name) => name.startsWith(prefix))
    .map((name) => ({ name, platform: name.slice(prefix.length), range: sdk.optionalDependencies[name] }))
    .sort((a, b) => a.platform.localeCompare(b.platform));
  if (platforms.length === 0) throw new Error('The SDK lists no platform packages in optionalDependencies.');

  const dir = keepDir ?? (await mkdtemp(join(tmpdir(), 'pin-copilot-runtime-')));
  await mkdir(dir, { recursive: true });
  const sources = [];
  try {
    for (const { name, platform, range } of platforms) {
      if (range !== sdkVersion) throw new Error(`${name} is ${range}, not the SDK's own ${sdkVersion}: pin by hand.`);
      const doc = await json(`${REGISTRY}/${name}/${sdkVersion}`);
      const url = new URL(doc.dist.tarball);
      if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org') {
        throw new Error(`${name}: tarball is on ${url.host}; add that host to COPILOT_RUNTIME_DOWNLOAD_HOSTS deliberately first.`);
      }
      const file = join(dir, `${platform}.tgz`);
      process.stderr.write(`${platform}: downloading ${url.href}\n`);
      const got = await download(url.href, file);
      const expected = String(doc.dist.integrity ?? '');
      if (!expected.startsWith('sha512-') || expected.slice(7) !== got.sha512) {
        throw new Error(`${name}: the registry's sha512 integrity does not match the downloaded bytes.`);
      }
      const launcher = `prebuilds/${platform}/${platform.startsWith('win32') ? 'copilot-runtime.exe' : 'copilot-runtime'}`;
      const entries = await listTgz(file);
      for (const needed of [launcher, `prebuilds/${platform}/runtime.node`]) {
        if (!(entries.get(`package/${needed}`) > 0)) throw new Error(`${name}: package/${needed} is missing or empty in the tarball.`);
      }
      const bytes = (await stat(file)).size;
      if (bytes !== got.size) throw new Error(`${name}: size mismatch while hashing.`);
      sources.push({ platform, package: name, url: url.href, sha256: got.sha256, size: got.size, launcher });
    }
  } finally {
    if (!keepDir) await rm(dir, { recursive: true, force: true });
  }

  const rows = sources
    .map(
      (s) => `  '${s.platform}': {
    platform: '${s.platform}',
    package: '${s.package}',
    url: '${s.url}',
    sha256: '${s.sha256}',
    size: ${s.size},
    launcher: '${s.launcher}',
  },`,
    )
    .join('\n');
  const next = `// GENERATED by scripts/pin-copilot-runtime.mjs from package.json's @github/copilot-sdk. Do not edit by hand:
// re-run \`node scripts/pin-copilot-runtime.mjs\` after bumping the SDK, review the diff and commit it.
//
// The Copilot runtime is the optional npm package \`@github/copilot-sdk-<platform>\`. Nobody publishes a SHA-256
// for it, so each digest below was computed by us from the registry tarball (and cross-checked against the
// registry's sha512 integrity). Marinoscar/kvox-desktop#32; the table is consumed by copilot-runtime-source.ts.

/** One platform's pinned runtime package. */
export interface CopilotRuntimeSource {
  /** The SDK's platform suffix (\`linux-x64\`, \`linuxmusl-arm64\`, \`win32-x64\`, ...). */
  readonly platform: string;
  readonly package: string;
  /** The registry tarball (https, exact version). */
  readonly url: string;
  /** SHA-256 (hex) of that tarball, computed by the pin script. */
  readonly sha256: string;
  /** The tarball's size in bytes. */
  readonly size: number;
  /** The launcher inside the package (its sibling \`runtime.node\` and the package's other files stay beside it). */
  readonly launcher: string;
}

/** The \`@github/copilot-sdk\` version the table was generated for (must equal package.json's). */
export const COPILOT_SDK_PINNED_VERSION = '${sdkVersion}';

/** The runtime (Copilot CLI) version that SDK pins. */
export const COPILOT_RUNTIME_PINNED_VERSION = '${runtimeVersion}';

export const COPILOT_RUNTIME_SOURCES: Readonly<Record<string, CopilotRuntimeSource>> = Object.freeze({
${rows}
});
`;
  if (check) {
    const current = await readFile(TABLE_PATH, 'utf8').catch(() => '');
    if (current !== next) {
      process.stderr.write('copilot-runtime-sources.ts is stale: run node scripts/pin-copilot-runtime.mjs\n');
      process.exit(1);
    }
    process.stderr.write('copilot-runtime-sources.ts is up to date.\n');
    return;
  }
  await writeFile(TABLE_PATH, next);
  process.stderr.write(`wrote ${TABLE_PATH}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
});
