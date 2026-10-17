#!/usr/bin/env node
// =============================================================================
// The release job's file work (marinoscar/kvox#587)
// =============================================================================
//
//   node scripts/release-files.mjs merge-mac <out.yml> <part.yml>...
//       The two macOS runners (Apple silicon, Intel) each write a
//       `latest-mac.yml` listing only their own zip and dmg. electron-updater
//       on a Mac picks its architecture's file from ONE `latest-mac.yml`, so
//       the release carries the merge: every part's `files:` entries, the
//       first part's top-level fields (version, path, sha512, releaseDate).
//
//   node scripts/release-files.mjs checksums <dir>
//       Writes <dir>/SHA256SUMS (`sha256sum -c` format) for every file in it.
//
//   node scripts/release-files.mjs gate <dir>
//       Reads the signing plans the builds left (signing-*.json, from
//       scripts/dist.mjs) and prints `publish=true` only when Windows was
//       signed and macOS signed AND notarized on every runner; otherwise
//       `publish=false` and why. Unsigned installers stay in a draft release.
// =============================================================================

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Splits an electron-builder update-info file into its `files:` entries and the other top-level lines. */
function parseUpdateInfo(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const top = [];
  const entries = [];
  let inFiles = false;
  for (const line of lines) {
    if (line === 'files:') {
      inFiles = true;
      continue;
    }
    if (inFiles && /^ {2}- /.test(line)) {
      entries.push([line]);
      continue;
    }
    if (inFiles && /^ {4}\S/.test(line) && entries.length > 0) {
      entries[entries.length - 1].push(line);
      continue;
    }
    inFiles = false;
    if (line.trim() !== '') top.push(line);
  }
  return { top, entries };
}

/** The merge of several `latest-mac.yml` texts (see the header). */
export function mergeUpdateInfo(texts) {
  if (texts.length === 0) throw new Error('nothing to merge');
  const parts = texts.map(parseUpdateInfo);
  const version = (part) => part.top.find((line) => line.startsWith('version:'));
  const versions = new Set(parts.map(version));
  if (versions.size !== 1) throw new Error(`the parts disagree on the version: ${[...versions].join(' / ')}`);
  const seen = new Set();
  const files = [];
  for (const part of parts) {
    for (const entry of part.entries) {
      const url = entry[0].replace(/^ {2}- url: /, '');
      if (seen.has(url)) continue;
      seen.add(url);
      files.push(...entry);
    }
  }
  const [first] = parts;
  const versionLine = version(first);
  const rest = first.top.filter((line) => line !== versionLine);
  return [versionLine, 'files:', ...files, ...rest, ''].join('\n');
}

/** `<sha256>  <name>` for every regular file of a directory but SHA256SUMS itself, sorted by name. */
export function checksums(dir) {
  return readdirSync(dir)
    .filter((name) => !name.startsWith('SHA256SUMS') && statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => `${createHash('sha256').update(readFileSync(join(dir, name))).digest('hex')}  ${name}`)
    .join('\n')
    .concat('\n');
}

/** Whether every signing plan says signed (and notarized); the reasons when not. */
export function gate(plans) {
  const reasons = [];
  const has = (platform) => plans.some((plan) => plan.platform === platform);
  if (!has('win32')) reasons.push('no Windows build');
  if (!has('darwin')) reasons.push('no macOS build');
  for (const plan of plans) {
    if (plan.platform === 'win32' && !plan.windowsSigned) reasons.push(`Windows (${plan.arch}) is not signed`);
    if (plan.platform === 'darwin' && !plan.macSigned) reasons.push(`macOS (${plan.arch}) is not signed`);
    if (plan.platform === 'darwin' && plan.macSigned && !plan.macNotarized) reasons.push(`macOS (${plan.arch}) is not notarized`);
  }
  return { publish: reasons.length === 0, reasons };
}

function main([command, ...args]) {
  if (command === 'merge-mac') {
    const [out, ...parts] = args;
    writeFileSync(out, mergeUpdateInfo(parts.map((path) => readFileSync(path, 'utf8'))));
    console.log(`merge-mac: ${parts.map((p) => basename(p)).join(' + ')} -> ${basename(out)}`);
  } else if (command === 'checksums') {
    const dir = resolve(args[0]);
    writeFileSync(join(dir, 'SHA256SUMS'), checksums(dir));
    console.log(readFileSync(join(dir, 'SHA256SUMS'), 'utf8').trimEnd());
  } else if (command === 'gate') {
    const dir = resolve(args[0]);
    const plans = readdirSync(dir)
      .filter((name) => /^signing-.*\.json$/.test(name))
      .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));
    const { publish, reasons } = gate(plans);
    console.log(`publish=${publish}`);
    for (const reason of reasons) console.log(`reason=${reason}`);
  } else {
    console.error('usage: release-files.mjs merge-mac <out> <part>... | checksums <dir> | gate <dir>');
    process.exit(2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
