import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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
