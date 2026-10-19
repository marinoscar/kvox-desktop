import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { signingPlan } from '../../scripts/dist.mjs';
import { EXPECTED_FUSES, MAX_LOOSE_FILE_BYTES, copilotRuntimeProblems } from '../../scripts/packaged-app.mjs';
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
// The Copilot runtime is not in the installer (marinoscar/kvox-desktop#23)
// =============================================================================
//
// `@github/copilot-sdk` drives a separate runtime of 130 to 175 MB per platform.
// The default installer downloads it on the first opt-in, so it must carry neither
// the runtime nor the per-platform npm packages that hold it. The optional
// with-copilot flavour ships it as an extraResource, outside app.asar.
// =============================================================================

describe('the Copilot runtime stays out of the default installer', () => {
  const flavour = read('electron-builder.with-copilot.yml');

  it('excludes the per-platform runtime packages from the archive and ships no extraResources', () => {
    expect(config).toContain('  - "!node_modules/@github/copilot-sdk-*/**"\n');
    expect(config).not.toMatch(/^extraResources:/m);
    expect(config).not.toMatch(/^\s*- node_modules\/@github\/copilot-sdk\*\*/m);
    // Nothing is unpacked from the SDK either: the runtime is never run from node_modules.
    const unpack = /^asarUnpack:\n((?: {2}.+\n)+)/m.exec(config)?.[1] ?? '';
    expect(unpack).not.toMatch(/copilot/);
  });

  it('keeps the runtime packages out of the app\'s own dependencies (the SDK pulls them in as optional ones)', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string>; optionalDependencies?: Record<string, string> };
    expect(Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }).filter((name) => name.startsWith('@github/copilot-sdk-'))).toEqual([]);
  });

  it('puts the bundled flavour behind its own config: the runtime is an extraResource in resources/copilot, outside the archive', () => {
    expect(flavour).toContain('extends: electron-builder.yml');
    expect(flavour).toMatch(/^extraResources:\n {2}- from: build\/copilot-runtime\/\$\{os\}-\$\{arch\}\n {4}to: copilot\n/m);
    expect(flavour).toContain('output: release-with-copilot');
    // The flavour does not touch `files` or `asarUnpack`: still no runtime inside app.asar.
    expect(flavour).not.toMatch(/^(files|asarUnpack):/m);
    expect(read('src', 'server', 'ai', 'copilot-runtime-location.ts')).toContain("BUNDLED_RUNTIME_FOLDER = 'copilot'");
  });

  describe('copilotRuntimeProblems (packaged-app.mjs verify)', () => {
    let resources: string | undefined;
    afterEach(() => resources && rmSync(resources, { recursive: true, force: true }));

    function layout(files: Record<string, number>): string {
      resources = mkdtempSync(join(tmpdir(), 'kvox-resources-'));
      for (const [path, size] of Object.entries(files)) {
        mkdirSync(join(resources, path, '..'), { recursive: true });
        writeFileSync(join(resources, path), '');
        if (size > 0) truncateSync(join(resources, path), size); // sparse: no disk used
      }
      return resources;
    }
    const RUNTIME = 140 * 1024 * 1024; // the real runtime.node is about 136 MB

    it('passes a default installer layout', () => {
      const dir = layout({ 'app.asar': 150 * 1024 * 1024, 'app.asar.unpacked/prisma.config.ts': 10, 'app.asar.unpacked/node_modules/@prisma/engines/schema-engine-debian': 20 * 1024 * 1024 });
      expect(copilotRuntimeProblems(dir, { archiveEntries: ['/node_modules/@github/copilot-sdk/dist/index.js'] })).toEqual([]);
    });

    it('fails a runtime beside the archive, a platform package in the archive, and any oversize file', () => {
      const loose = layout({ 'app.asar': 10, 'copilot/copilot-runtime': 500_000, 'copilot/runtime.node': RUNTIME });
      expect(copilotRuntimeProblems(loose)).toEqual([
        'the Copilot runtime is in the installer (resources/copilot/copilot-runtime)',
        'the Copilot runtime is in the installer (resources/copilot/runtime.node)',
      ]);
      expect(copilotRuntimeProblems(layout({ 'app.asar': 10 }), { archiveEntries: ['/node_modules/@github/copilot-sdk-linux-x64/prebuilds/linux-x64/runtime.node'] })).toEqual([
        'app.asar contains the Copilot runtime (/node_modules/@github/copilot-sdk-linux-x64/prebuilds/linux-x64/runtime.node)',
      ]);
      const big = layout({ 'app.asar': MAX_LOOSE_FILE_BYTES * 3, 'extra/model.bin': MAX_LOOSE_FILE_BYTES + 1 });
      expect(copilotRuntimeProblems(big)).toEqual([`resources/extra/model.bin is ${Math.round((MAX_LOOSE_FILE_BYTES + 1) / 1048576)} MB, over the 100 MB size budget`]);
    });

    it('lets the with-copilot flavour carry the runtime in resources/copilot and nowhere else', () => {
      const ok = layout({ 'app.asar': 10, 'copilot/copilot-runtime': 500_000, 'copilot/runtime.node': RUNTIME });
      expect(copilotRuntimeProblems(ok, { allowBundled: true })).toEqual([]);
      const elsewhere = layout({ 'app.asar': 10, 'app.asar.unpacked/runtime.node': RUNTIME });
      expect(copilotRuntimeProblems(elsewhere, { allowBundled: true })).toHaveLength(1);
      expect(copilotRuntimeProblems(layout({ 'app.asar': 10 }), { allowBundled: true, archiveEntries: ['/node_modules/@github/copilot-sdk-win32-x64/x'] })).toHaveLength(1);
    });
  });
});
