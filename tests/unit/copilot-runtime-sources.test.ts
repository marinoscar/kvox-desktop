import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { COPILOT_RUNTIME_VERSION } from '@marinoscar/kvox-ai/copilot';
import { describe, expect, it } from 'vitest';

import { COPILOT_RUNTIME_DOWNLOAD_HOSTS } from '../../src/server/ai/copilot-sandbox';
import { copilotRuntimeSourceFor, downloadFromSource, planRuntimeDownload, sdkPlatformName } from '../../src/server/ai/copilot-runtime-source';
import {
  COPILOT_RUNTIME_PINNED_VERSION,
  COPILOT_RUNTIME_SOURCES,
  COPILOT_SDK_PINNED_VERSION,
} from '../../src/server/ai/copilot-runtime-sources';

// =============================================================================
// The pinned Copilot runtime sources (marinoscar/kvox-desktop#32)
// =============================================================================
//
// Fails when the generated table (`scripts/pin-copilot-runtime.mjs`) no longer
// matches the SDK the repository pins: a bumped `@github/copilot-sdk` that was not
// re-pinned, a platform the SDK ships that the table lacks, a tarball URL on a host
// the download may not reach. Offline: it reads the installed SDK's package.json.
// =============================================================================

const root = join(__dirname, '..', '..');
const own = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
const sdkManifest = JSON.parse(readFileSync(join(root, 'node_modules', '@github', 'copilot-sdk', 'package.json'), 'utf8')) as {
  version: string;
  copilotRuntime?: { version: string };
  copilotCliVersion?: string;
  optionalDependencies: Record<string, string>;
};
const PREFIX = '@github/copilot-sdk-';

describe('the pinned Copilot runtime sources', () => {
  it('are generated for the exact SDK version package.json pins (run scripts/pin-copilot-runtime.mjs after a bump)', () => {
    expect(own.dependencies['@github/copilot-sdk']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(COPILOT_SDK_PINNED_VERSION).toBe(own.dependencies['@github/copilot-sdk']);
    expect(sdkManifest.version).toBe(COPILOT_SDK_PINNED_VERSION);
    expect(COPILOT_RUNTIME_PINNED_VERSION).toBe(sdkManifest.copilotRuntime?.version ?? sdkManifest.copilotCliVersion);
    // The package's own default names the same runtime; a drift needs a deliberate look.
    expect(COPILOT_RUNTIME_PINNED_VERSION).toBe(COPILOT_RUNTIME_VERSION);
  });

  it('cover every platform package the SDK lists in optionalDependencies, and nothing else', () => {
    const wanted = Object.keys(sdkManifest.optionalDependencies)
      .filter((name) => name.startsWith(PREFIX))
      .map((name) => name.slice(PREFIX.length))
      .sort();
    expect(wanted.length).toBeGreaterThanOrEqual(6);
    expect(Object.keys(COPILOT_RUNTIME_SOURCES).sort()).toEqual(wanted);
  });

  it.each(Object.entries(COPILOT_RUNTIME_SOURCES))('%s pins an exact registry tarball with a SHA-256', (platform, source) => {
    const name = `${PREFIX}${platform}`;
    expect(source.platform).toBe(platform);
    expect(source.package).toBe(name);
    expect(sdkManifest.optionalDependencies[name]).toBe(COPILOT_SDK_PINNED_VERSION);
    expect(source.url).toBe(`https://registry.npmjs.org/${name}/-/${name.slice('@github/'.length)}-${COPILOT_SDK_PINNED_VERSION}.tgz`);
    expect(new URL(source.url).hostname).toSatisfy((host: string) => COPILOT_RUNTIME_DOWNLOAD_HOSTS.includes(host));
    expect(source.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(source.size).toBeGreaterThan(10_000_000);
    expect(source.launcher).toBe(`prebuilds/${platform}/${platform.startsWith('win32') ? 'copilot-runtime.exe' : 'copilot-runtime'}`);
  });

  it('use distinct digests (a copy-paste between platforms would pin the wrong file)', () => {
    const digests = Object.values(COPILOT_RUNTIME_SOURCES).map((source) => source.sha256);
    expect(new Set(digests).size).toBe(digests.length);
  });

  it('allow the registry host for the download and no GitHub release host', () => {
    expect([...COPILOT_RUNTIME_DOWNLOAD_HOSTS]).toEqual(['registry.npmjs.org']);
  });
});

describe('planRuntimeDownload', () => {
  it('returns the pinned download for a supported platform', () => {
    const plan = planRuntimeDownload('linux-x64');
    expect(plan).toMatchObject({ supported: true, platform: 'linux-x64' });
    if (!plan.supported) throw new Error('unreachable');
    const source = COPILOT_RUNTIME_SOURCES['linux-x64']!;
    expect(plan.download).toMatchObject({ url: source.url, sha256: source.sha256, version: COPILOT_RUNTIME_PINNED_VERSION, maxBytes: source.size });
    expect(typeof plan.download.extract).toBe('function');
  });

  it('says why when GitHub ships no runtime for the platform', () => {
    for (const platform of ['freebsd-x64', 'linux-ia32', 'darwin-ppc64', '__proto__', 'constructor']) {
      const plan = planRuntimeDownload(platform);
      expect(plan.supported, platform).toBe(false);
      if (!plan.supported) expect(plan.reason).toContain(platform);
    }
    expect(copilotRuntimeSourceFor('toString')).toBeUndefined();
  });

  it('names the SDK platforms (glibc and musl Linux)', () => {
    expect(sdkPlatformName('linux', 'x64', true)).toBe('linux-x64');
    expect(sdkPlatformName('linux', 'arm64', false)).toBe('linuxmusl-arm64');
    expect(sdkPlatformName('darwin', 'arm64', true)).toBe('darwin-arm64');
    expect(sdkPlatformName('win32', 'x64', true)).toBe('win32-x64');
  });

  it('caps the download at the pinned size', () => {
    const source = COPILOT_RUNTIME_SOURCES['win32-x64']!;
    expect(downloadFromSource(source).maxBytes).toBe(source.size);
  });
});
