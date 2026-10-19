import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CopilotDownloadUnavailableError, createDefaultCopilotHost } from '../../src/server/ai/copilot-host';
import { runningCopilotSandboxes } from '../../src/server/ai/copilot-sandbox';
import { dataFolder } from '../../src/server/data-folder';

// =============================================================================
// The default Copilot host (marinoscar/kvox-desktop#21 over #23's sandbox)
// =============================================================================
//
// The real transport factory, without starting the SDK or a runtime (the SDK is
// required on the transport's first call, which never happens here): building the
// transport starts the egress sandbox and puts its environment in BEFORE the
// runtime could be spawned; stopping it puts everything back.
// =============================================================================

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function folder() {
  const root = mkdtempSync(join(tmpdir(), 'kvox-copilot-host-'));
  roots.push(root);
  return dataFolder(root);
}

describe('createDefaultCopilotHost', () => {
  it('starts the sandbox with the transport, applies its environment first, and restores it on stop', async () => {
    const lines: string[] = [];
    const host = createDefaultCopilotHost({ folder: folder(), log: (line) => lines.push(line), bundledRuntimePath: null });
    const before = { proxy: process.env.HTTPS_PROXY, noProxy: process.env.NO_PROXY, cli: process.env.COPILOT_CLI_PATH };
    process.env.GH_TOKEN = 'gho_PLANTEDhosttest0123456789abcdef';
    try {
      const transport = await host.createTransport({
        runtimePath: '/nonexistent/copilot-runtime',
        baseDirectory: join(host.dataDirectory, 'home'),
        workingDirectory: join(host.dataDirectory, 'work'),
        version: '1.0.98',
        source: 'bundled',
        verified: true,
      });
      expect(runningCopilotSandboxes()).toHaveLength(1);
      expect(process.env.HTTPS_PROXY).toMatch(/^http:\/\/[^@]+@127\.0\.0\.1:\d+/);
      expect(process.env.NO_PROXY).toBe('');
      expect(process.env.GH_TOKEN).toBeUndefined(); // the runtime must not sign in on its own
      expect(process.env.COPILOT_CLI_PATH).toBe('/nonexistent/copilot-runtime');

      await transport.stop?.();
      expect(runningCopilotSandboxes()).toHaveLength(0);
      expect(process.env.HTTPS_PROXY).toBe(before.proxy);
      expect(process.env.NO_PROXY).toBe(before.noProxy);
      expect(process.env.GH_TOKEN).toBe('gho_PLANTEDhosttest0123456789abcdef');
      expect(lines.join('\n')).not.toMatch(/gho_|Bearer |@127\.0\.0\.1/);
    } finally {
      delete process.env.GH_TOKEN;
      if (before.cli === undefined) delete process.env.COPILOT_CLI_PATH;
      else process.env.COPILOT_CLI_PATH = before.cli;
    }
  });

  it('prefers a bundled launcher, and refuses a download that has no configured source', async () => {
    const dataFolderForTest = folder();
    const host = createDefaultCopilotHost({ folder: dataFolderForTest, log: () => undefined, bundledRuntimePath: null });
    expect(host.canDownload).toBe(false);
    await expect(host.prepareRuntime({ dataDirectory: host.dataDirectory, download: true })).rejects.toBeInstanceOf(CopilotDownloadUnavailableError);
    await expect(host.prepareRuntime({ dataDirectory: host.dataDirectory, download: false })).rejects.toMatchObject({ response: { details: { check: 'runtime_missing' } } });

    const launcher = join(dataFolderForTest.root, 'bundle', 'copilot-runtime');
    mkdirSync(join(dataFolderForTest.root, 'bundle'), { recursive: true });
    writeFileSync(launcher, 'launcher');
    const bundled = createDefaultCopilotHost({ folder: dataFolderForTest, log: () => undefined, bundledRuntimePath: launcher });
    const prepared = await bundled.prepareRuntime({ dataDirectory: bundled.dataDirectory, download: false });
    expect(prepared).toMatchObject({ runtimePath: launcher, source: 'bundled', baseDirectory: join(bundled.dataDirectory, 'home') });
    // A bundled runtime is never downloaded over, even when asked.
    await expect(bundled.prepareRuntime({ dataDirectory: bundled.dataDirectory, download: true })).rejects.toBeInstanceOf(CopilotDownloadUnavailableError);
  });

  it('removes the Copilot data through the folder, keeping the runtime unless asked', async () => {
    const f = folder();
    const host = createDefaultCopilotHost({ folder: f, log: () => undefined, bundledRuntimePath: null });
    for (const name of ['home', 'work', 'runtime']) mkdirSync(join(f.copilot, name), { recursive: true });
    expect(await host.removeData!({})).toEqual({ removed: ['home', 'work'], keptRuntime: true });
    expect(await host.removeData!({ includeRuntime: true })).toMatchObject({ keptRuntime: false });
  });
});
