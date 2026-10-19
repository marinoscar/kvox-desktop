import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ICNS_ENTRIES,
  ICO_SIZES,
  LINUX_SIZES,
  assertKvoxMark,
  buildIcns,
  buildIco,
  compareIcons,
  generateIcons,
  resolveMark,
} from '../../scripts/build-icons.mjs';
import { signingPlan } from '../../scripts/dist.mjs';
import { EXPECTED_FUSES } from '../../scripts/packaged-app.mjs';
import { unpackedSchemaEngine, workingDirectoryOf } from '../../src/server/database';

// =============================================================================
// Packaging, signing and the asar layout (marinoscar/kvox#587)
// =============================================================================
//
// The signing plan builds unsigned installers without secrets and signs (and
// notarizes) exactly when they are present, never printing a value. The
// electron-builder config carries the fuses scripts/packaged-app.mjs verifies
// in the built binary, the asar layout database.ts relies on and the AppArmor
// profile of the .deb. CI then proves the built app migrates and passes the
// smoke test (tests/e2e) with this layout and these fuses.
// =============================================================================

const ROOT = resolve(__dirname, '..', '..');
// Line endings normalized: a Windows checkout has CRLF.
const read = (...path: string[]) => readFileSync(join(ROOT, ...path), 'utf8').replace(/\r\n/g, '\n');
const config = read('electron-builder.yml');

const AZURE = {
  AZURE_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net',
  AZURE_SIGNING_ACCOUNT: 'kvox-account',
  AZURE_SIGNING_CERT_PROFILE: 'kvox-profile',
  AZURE_SIGNING_PUBLISHER_NAME: 'Oscar Marin',
};
// Placeholders (each value is its own name, so a leaked value would be recognisable in a notice).
const placeholders = (names: string[]) => Object.fromEntries(names.map((name) => [name, `placeholder-${name.toLowerCase()}`]));
const APPLE = placeholders(['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']);

describe('signingPlan', () => {
  it('builds unsigned without secrets, saying so on every platform', () => {
    const win = signingPlan({}, 'win32');
    expect(win.windowsSigned).toBe(false);
    expect(win.args).toEqual([]);
    expect(win.notices.join()).toMatch(/Windows: NOT signed \(AZURE_SIGNING_ENDPOINT, .*\)/);

    const mac = signingPlan({}, 'darwin');
    expect(mac.macSigned).toBe(false);
    expect(mac.args).toEqual(['-c.mac.identity=null', '-c.mac.notarize=false']);
    expect(mac.env).toEqual({ CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
    expect(mac.notices.join()).toMatch(/macOS: NOT signed/);

    expect(signingPlan({}, 'linux').args).toEqual([]);
  });

  it('signs Windows with Azure Trusted Signing only when all four settings exist', () => {
    const plan = signingPlan(AZURE, 'win32');
    expect(plan.windowsSigned).toBe(true);
    expect(plan.args).toContain('-c.win.azureSignOptions.publisherName=Oscar Marin');
    expect(plan.args).toContain('-c.win.azureSignOptions.codeSigningAccountName=kvox-account');
    const partial = signingPlan({ ...AZURE, AZURE_SIGNING_CERT_PROFILE: ' ' }, 'win32');
    expect(partial.windowsSigned).toBe(false);
    expect(partial.notices.join()).toContain('AZURE_SIGNING_CERT_PROFILE');
  });

  it('signs macOS with the certificate and notarizes only with the whole API key', () => {
    const full = signingPlan(APPLE, 'darwin');
    expect(full).toMatchObject({ macSigned: true, macNotarized: true, args: ['-c.mac.notarize=true'] });
    const noKey = signingPlan({ ...APPLE, APPLE_API_ISSUER: '' }, 'darwin');
    expect(noKey).toMatchObject({ macSigned: true, macNotarized: false, args: ['-c.mac.notarize=false'] });
    expect(noKey.notices.join()).toContain('NOT notarized (APPLE_API_ISSUER not set)');
  });

  it('never puts a secret value in a notice', () => {
    const notices = [...signingPlan({ ...AZURE, ...APPLE }, 'darwin').notices, ...signingPlan({ ...AZURE, ...APPLE }, 'win32').notices].join('\n');
    for (const secret of [APPLE.CSC_LINK, APPLE.CSC_KEY_PASSWORD, APPLE.APPLE_API_KEY, APPLE.APPLE_API_ISSUER, AZURE.AZURE_SIGNING_ENDPOINT]) {
      expect(notices).not.toContain(secret);
    }
  });
});

describe('electron-builder.yml', () => {
  it('flips exactly the fuses the packaged-app check expects', () => {
    const block = /^electronFuses:\n((?: {2}.+\n)+)/m.exec(config)?.[1] ?? '';
    const fuses = Object.fromEntries([...block.matchAll(/^ {2}(\w+): (true|false)$/gm)].map((m) => [m[1], m[2] === 'true']));
    const key = (name: string) => name.charAt(0).toLowerCase() + name.slice(1);
    for (const [name, expected] of Object.entries(EXPECTED_FUSES)) expect(fuses[key(name)], name).toBe(expected);
    // The migrations do not need Node mode: they run as utility processes.
    expect(fuses.runAsNode).toBe(false);
  });

  it('packs the app into asar and unpacks what is started as a process', () => {
    expect(config).toMatch(/^asar: true$/m);
    for (const entry of ['prisma/**', 'prisma.config.ts', 'node_modules/@prisma/engines/schema-engine*']) {
      expect(config).toContain(`  - ${entry}\n`);
    }
    // A `resources/app` folder would be loaded instead of app.asar.
    expect(config).not.toMatch(/to: app\//);
  });

  it('ships the AppArmor profile in the .deb, for the packaged binary only', () => {
    expect(config).toContain('appArmorProfile: build/linux/kvox-desktop.apparmor');
    const profile = read('build', 'linux', 'kvox-desktop.apparmor');
    expect(profile).toContain('abi <abi/4.0>,');
    expect(profile).toMatch(/profile \$\{executable\} "\/opt\/\$\{sanitizedProductName\}\/\$\{executable\}" flags=\(unconfined\) \{\s+userns,/);
  });

  it('keeps the user data on uninstall unless the user asks, and never on an update', () => {
    expect(config).toContain('deleteAppDataOnUninstall: false');
    const nsh = read('build', 'installer.nsh');
    expect(nsh).toContain('${ifNot} ${isUpdated}');
    expect(nsh).toContain('/SD IDNO');
    expect(nsh).toContain('RMDir /r "$APPDATA\\${PRODUCT_NAME}"');
  });

  it('grants macOS the JIT entitlement and nothing else', () => {
    const plist = read('build', 'entitlements.mac.plist');
    expect([...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1])).toEqual(['com.apple.security.cs.allow-jit']);
  });
});

describe('the asar layout', () => {
  let dir: string | undefined;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('runs the migration commands from app.asar.unpacked, with the unpacked schema engine', () => {
    dir = mkdtempSync(join(tmpdir(), 'kvox-asar-'));
    const appRoot = join(dir, 'resources', 'app.asar');
    const engines = join(`${appRoot}.unpacked`, 'node_modules', '@prisma', 'engines');
    mkdirSync(engines, { recursive: true });
    writeFileSync(join(engines, 'package.json'), '{}');
    writeFileSync(join(engines, 'schema-engine-windows.exe'), '');
    expect(workingDirectoryOf(appRoot)).toBe(`${appRoot}.unpacked`);
    expect(unpackedSchemaEngine(appRoot)).toBe(join(engines, 'schema-engine-windows.exe'));
  });

  it('leaves a development checkout alone', () => {
    expect(workingDirectoryOf(ROOT)).toBe(ROOT);
    expect(unpackedSchemaEngine(ROOT)).toBeUndefined();
  });
});

// =============================================================================
// Application icons (marinoscar/kvox-desktop#20)
// =============================================================================
// The icons are generated by scripts/build-icons.mjs from the KVox mark of
// @marinoscar/kvox-web/brand (never drawn or copied by hand). These tests prove
// the files exist with the sizes electron-builder and the OSes need, and that
// electron-builder.yml points at them. Once the installed package carries the
// mark, the last test regenerates and fails when a committed icon differs.
// =============================================================================

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const file = (...path: string[]) => readFileSync(join(ROOT, ...path));
const pngSize = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

/** The (width, height, payload) of every image in an ICO. */
function readIco(ico: Buffer) {
  expect(ico.readUInt16LE(0)).toBe(0);
  expect(ico.readUInt16LE(2)).toBe(1);
  return Array.from({ length: ico.readUInt16LE(4) }, (_, index) => {
    const at = 6 + index * 16;
    const length = ico.readUInt32LE(at + 8);
    const offset = ico.readUInt32LE(at + 12);
    return { width: ico[at]! || 256, height: ico[at + 1]! || 256, payload: ico.subarray(offset, offset + length) };
  });
}

/** The (type, payload) of every entry in an ICNS. */
function readIcns(icns: Buffer) {
  expect(icns.subarray(0, 4).toString('ascii')).toBe('icns');
  expect(icns.readUInt32BE(4)).toBe(icns.length);
  const entries: Array<{ type: string; payload: Buffer }> = [];
  for (let at = 8; at < icns.length; ) {
    const length = icns.readUInt32BE(at + 4);
    entries.push({ type: icns.subarray(at, at + 4).toString('ascii'), payload: icns.subarray(at + 8, at + length) });
    at += length;
  }
  return entries;
}

describe('application icons', () => {
  it('build/icon.ico holds the seven Windows sizes, each a PNG of exactly that size', () => {
    const images = readIco(file('build', 'icon.ico'));
    expect(images.map((image) => image.width)).toEqual([16, 24, 32, 48, 64, 128, 256]);
    expect(images.map((image) => image.width)).toEqual([...ICO_SIZES]);
    for (const image of images) {
      expect(image.payload.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
      expect(pngSize(image.payload)).toEqual({ width: image.width, height: image.height });
    }
  });

  it('build/icon.icns holds 16 to 1024 with the @2x entries', () => {
    const entries = readIcns(file('build', 'icon.icns'));
    expect(entries.map((entry) => entry.type)).toEqual(ICNS_ENTRIES.map(([type]) => type));
    for (const [index, [, size]] of ICNS_ENTRIES.entries()) {
      expect(pngSize(entries[index]!.payload).width).toBe(size);
    }
    expect(Math.max(...ICNS_ENTRIES.map(([, size]) => size))).toBe(1024);
  });

  it('build/linux has the 512 PNG and one PNG per desktop-entry size', () => {
    expect(pngSize(file('build', 'linux', 'icon.png'))).toEqual({ width: 512, height: 512 });
    for (const size of LINUX_SIZES) {
      const png = file('build', 'linux', 'icons', `${size}x${size}.png`);
      expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
      expect(pngSize(png)).toEqual({ width: size, height: size });
    }
    expect(Math.min(...LINUX_SIZES)).toBe(16);
    expect(Math.max(...LINUX_SIZES)).toBe(512);
  });

  it('electron-builder.yml points Windows, the installers, Linux and macOS at them and carries the window icon', () => {
    expect(config).toMatch(/^win:\n(?:.*\n)*?  icon: build\/icon\.ico$/m);
    expect(config).toMatch(/^ {2}installerIcon: build\/icon\.ico$/m);
    expect(config).toMatch(/^ {2}uninstallerIcon: build\/icon\.ico$/m);
    expect(config).toMatch(/^mac:\n(?:.*\n)*?  icon: build\/icon\.icns$/m);
    expect(config).toMatch(/^linux:\n(?:.*\n)*?  icon: build\/linux\/icons$/m);
    expect(config).toMatch(/from: build\/icon\.ico\n\s+to: icon\.ico/);
    expect(config).toMatch(/from: build\/linux\/icon\.png\n\s+to: icon\.png/);
    expect(config).not.toMatch(/placeholder/i);
  });

  it('the generator refuses a file that is not the KVox mark and writes valid containers', () => {
    expect(() => assertKvoxMark('<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#123456"/></svg>')).toThrow(/not the KVox mark/);
    const png = file('build', 'linux', 'icons', '16x16.png');
    expect(readIco(buildIco([{ size: 16, png }])).map((i) => i.width)).toEqual([16]);
    expect(readIcns(buildIcns([{ type: 'icp4', png }])).map((e) => e.type)).toEqual(['icp4']);
  });

  const mark = resolveMark();
  // Until the installed @marinoscar/kvox-web exports the brand assets (marinoscar/kvox#628) there
  // is no source to compare with; `npm run icons -- --check` says so and fails.
  // Compared byte for byte on Linux only: the committed files were rasterized there, and CI's Windows
  // runner is not asked to reproduce a native rasterizer's output bit for bit.
  it.skipIf(mark === null || process.platform !== 'linux')('the committed icons match a regeneration from @marinoscar/kvox-web/brand', () => {
    const generated = generateIcons(readFileSync(mark!, 'utf8'));
    expect(compareIcons(generated, ROOT)).toEqual({ missing: [], changed: [], stale: [] });
  });
});
