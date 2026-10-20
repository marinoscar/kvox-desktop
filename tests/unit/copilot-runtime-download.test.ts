import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CopilotDownloadUnavailableError, createDefaultCopilotHost } from '../../src/server/ai/copilot-host';
import { downloadFromSource } from '../../src/server/ai/copilot-runtime-source';
import { COPILOT_RUNTIME_PINNED_VERSION, COPILOT_RUNTIME_SOURCES, type CopilotRuntimeSource } from '../../src/server/ai/copilot-runtime-sources';
import { dataFolder } from '../../src/server/data-folder';
import { runtimePackage, sha256, tgz, type TarEntry } from '../support/tgz';

// =============================================================================
// The whole Copilot runtime download flow (marinoscar/kvox-desktop#32)
// =============================================================================
//
// createDefaultCopilotHost -> prepareCopilotRuntime (the package) -> pinned source
// -> host checks -> SHA-256 -> strict extractor -> atomic install. No real network:
// `fetch` is injected and serves a fixture .tgz built by tests/support/tgz.
// =============================================================================

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function folder() {
  const root = mkdtempSync(join(tmpdir(), 'kvox-copilot-dl-'));
  roots.push(root);
  return dataFolder(root);
}

const PLATFORM = 'linux-x64';
const REAL_URL = COPILOT_RUNTIME_SOURCES[PLATFORM]!.url;
const ARCHIVE = tgz(runtimePackage(PLATFORM).entries);
const FIXTURE: CopilotRuntimeSource = {
  platform: PLATFORM,
  package: `@github/copilot-sdk-${PLATFORM}`,
  url: REAL_URL,
  sha256: sha256(ARCHIVE),
  size: ARCHIVE.length,
  launcher: runtimePackage(PLATFORM).launcher,
};

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
function serve(handler: Handler) {
  const calls: string[] = [];
  const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return handler(url, init);
  });
  return { fetch: fetchStub as unknown as typeof fetch, calls };
}

const ok = (body: Buffer = ARCHIVE): Response => new Response(new Uint8Array(body), { status: 200, headers: { 'content-length': String(body.length) } });

function host(options: Partial<Parameters<typeof createDefaultCopilotHost>[0]> & { fetch: typeof fetch }) {
  const f = folder();
  return { f, host: createDefaultCopilotHost({ folder: f, log: () => undefined, bundledRuntimePath: null, platform: PLATFORM, ...options }) };
}

/** Nothing of an install may remain: no version folder, no partial download, no staging folder. */
function runtimeLeftovers(directory: string): string[] {
  const dir = join(directory, 'runtime');
  return existsSync(dir) ? readdirSync(dir) : [];
}

describe('the Copilot runtime download', () => {
  it('downloads from the pinned registry URL, verifies, extracts and reports progress; the next start reuses it', async () => {
    const server = serve(() => ok());
    const { host: h } = host({ download: downloadFromSource(FIXTURE), fetch: server.fetch });
    expect(h.canDownload).toBe(true);

    const progress: Array<{ received: number; total?: number }> = [];
    const prepared = await h.prepareRuntime({ dataDirectory: h.dataDirectory, download: true, onProgress: (p) => progress.push(p) });

    expect(server.calls).toEqual([REAL_URL]);
    expect(prepared).toMatchObject({ source: 'downloaded', verified: true, version: COPILOT_RUNTIME_PINNED_VERSION });
    expect(prepared.runtimePath).toBe(join(h.dataDirectory, 'runtime', COPILOT_RUNTIME_PINNED_VERSION, 'prebuilds', PLATFORM, 'copilot-runtime'));
    expect(readFileSync(prepared.runtimePath, 'utf8')).toBe('#!launcher\n');
    // The launcher's sibling is beside it, as the launcher requires.
    expect(statSync(join(prepared.runtimePath, '..', 'runtime.node')).size).toBe(4096);
    if (process.platform !== 'win32') expect(statSync(prepared.runtimePath).mode & 0o111).not.toBe(0);
    expect(progress[0]).toMatchObject({ received: 0 });
    expect(progress.at(-1)).toMatchObject({ received: ARCHIVE.length, total: ARCHIVE.length });
    expect(runtimeLeftovers(h.dataDirectory)).toEqual([COPILOT_RUNTIME_PINNED_VERSION]);

    // Ordinary start: the installed runtime is found without the network.
    const again = await h.prepareRuntime({ dataDirectory: h.dataDirectory, download: true });
    expect(again.source).toBe('cached');
    expect(server.calls).toHaveLength(1);
  });

  it('finds a downloaded runtime again on an ordinary start (a restart), without any network and without asking to download', async () => {
    const first = serve(() => ok());
    const { f, host: h } = host({ download: downloadFromSource(FIXTURE), fetch: first.fetch });
    const downloaded = await h.prepareRuntime({ dataDirectory: h.dataDirectory, download: true });

    // A new process: a fresh host over the same data folder. Its start asks for NO download, and its fetch is never reached.
    const restart = serve(() => {
      throw new Error('the network must not be used');
    });
    const restarted = createDefaultCopilotHost({ folder: f, log: () => undefined, bundledRuntimePath: null, platform: PLATFORM, download: downloadFromSource(FIXTURE), fetch: restart.fetch });
    const prepared = await restarted.prepareRuntime({ dataDirectory: restarted.dataDirectory, download: false });
    expect(prepared).toMatchObject({ source: 'cached', runtimePath: downloaded.runtimePath, version: COPILOT_RUNTIME_PINNED_VERSION });
    expect(restart.calls).toEqual([]);
  });

  it('reports "missing", and never downloads, on an ordinary start when nothing was downloaded', async () => {
    const server = serve(() => ok());
    const { host: h } = host({ download: downloadFromSource(FIXTURE), fetch: server.fetch });
    await expect(h.prepareRuntime({ dataDirectory: h.dataDirectory, download: false })).rejects.toMatchObject({ response: { details: { check: 'runtime_missing' } } });
    expect(server.calls).toEqual([]);
    expect(runtimeLeftovers(h.dataDirectory)).toEqual([]);
  });

  it('refuses a checksum mismatch and leaves nothing installed', async () => {
    const tampered = tgz(runtimePackage(PLATFORM).entries.map((e) => (e.name.endsWith('/copilot-runtime') ? { ...e, body: '#!evil\n' } : e)));
    const server = serve(() => ok(tampered));
    const { host: h } = host({ download: downloadFromSource(FIXTURE), fetch: server.fetch });
    await expect(h.prepareRuntime({ dataDirectory: h.dataDirectory, download: true })).rejects.toMatchObject({ response: { details: { check: 'checksum_mismatch' } } });
    expect(runtimeLeftovers(h.dataDirectory)).toEqual([]);
  });

  it('wires the real pinned table by default: the exact registry URL is asked for, and its pin is enforced', async () => {
    const server = serve(() => ok()); // the fixture is not the pinned file
    const { host: h } = host({ fetch: server.fetch });
    expect(h.canDownload).toBe(true);
    await expect(h.prepareRuntime({ dataDirectory: h.dataDirectory, download: true })).rejects.toMatchObject({ response: { details: { check: 'checksum_mismatch' } } });
    expect(server.calls).toEqual([REAL_URL]);
    expect(runtimeLeftovers(h.dataDirectory)).toEqual([]);
  });

  it('refuses a verified archive that breaks the extractor rules, and leaves nothing installed', async () => {
    const evil: TarEntry[] = [...runtimePackage(PLATFORM).entries, { name: 'package/../../escape', body: 'x' }];
    const archive = tgz(evil);
    const server = serve(() => ok(archive));
    const { host: h } = host({ download: downloadFromSource({ ...FIXTURE, sha256: sha256(archive), size: archive.length }), fetch: server.fetch });
    await expect(h.prepareRuntime({ dataDirectory: h.dataDirectory, download: true })).rejects.toThrow(/climbs out of its folder/);
    expect(runtimeLeftovers(h.dataDirectory)).toEqual([]);
    expect(existsSync(join(h.dataDirectory, '..', 'escape'))).toBe(false);
  });

  it('refuses a body larger than the pinned size', async () => {
    const server = serve(() => ok(Buffer.concat([ARCHIVE, Buffer.alloc(64)])));
    const { host: h } = host({ download: downloadFromSource(FIXTURE), fetch: server.fetch });
    await expect(h.prepareRuntime({ dataDirectory: h.dataDirectory, download: true })).rejects.toMatchObject({ response: { details: { check: 'download_too_large' } } });
    expect(runtimeLeftovers(h.dataDirectory)).toEqual([]);
  });

  describe('the download hosts (the package enforces them; this proves the host passes the right list)', () => {
    const refusals: Array<[string, string]> = [
      ['a host outside the allowlist', 'https://evil.example/runtime.tgz'],
      ['a GitHub release host (no longer allowed)', 'https://github.com/github/copilot-cli/releases/download/v1/x.tgz'],
      ['a look-alike host', 'https://registry.npmjs.org.evil.example/x.tgz'],
      ['plain http', 'http://registry.npmjs.org/x.tgz'],
      ['credentials in the URL', 'https://user:pass@registry.npmjs.org/x.tgz'],
      ['a non-default port', 'https://registry.npmjs.org:8443/x.tgz'],
    ];
    for (const [label, url] of refusals) {
      it(`refuses ${label} before any network call`, async () => {
        const server = serve(() => ok());
        const { host: h } = host({ download: { ...downloadFromSource(FIXTURE), url }, fetch: server.fetch });
        await expect(h.prepareRuntime({ dataDirectory: h.dataDirectory, download: true })).rejects.toMatchObject({ response: { details: { check: 'download_host_refused' } } });
        expect(server.calls).toEqual([]);
        expect(runtimeLeftovers(h.dataDirectory)).toEqual([]);
      });
    }

    it('refuses a redirect to another host (checked before it is requested), and follows one that stays on the registry', async () => {
      const away = serve(() => new Response(null, { status: 302, headers: { location: 'https://cdn.evil.example/runtime.tgz' } }));
      const a = host({ download: downloadFromSource(FIXTURE), fetch: away.fetch });
      await expect(a.host.prepareRuntime({ dataDirectory: a.host.dataDirectory, download: true })).rejects.toMatchObject({ response: { details: { check: 'download_host_refused' } } });
      expect(away.calls).toEqual([REAL_URL]); // the second hop was never requested

      const downgrade = serve(() => new Response(null, { status: 301, headers: { location: 'http://registry.npmjs.org/x.tgz' } }));
      const d = host({ download: downloadFromSource(FIXTURE), fetch: downgrade.fetch });
      await expect(d.host.prepareRuntime({ dataDirectory: d.host.dataDirectory, download: true })).rejects.toMatchObject({ response: { details: { check: 'download_host_refused' } } });

      let hop = 0;
      const same = serve(() => (hop++ === 0 ? new Response(null, { status: 302, headers: { location: 'https://registry.npmjs.org/mirror/x.tgz' } }) : ok()));
      const s = host({ download: downloadFromSource(FIXTURE), fetch: same.fetch });
      await expect(s.host.prepareRuntime({ dataDirectory: s.host.dataDirectory, download: true })).resolves.toMatchObject({ source: 'downloaded' });
      expect(same.calls).toEqual([REAL_URL, 'https://registry.npmjs.org/mirror/x.tgz']);
    });
  });

  it('cancels with the signal and leaves nothing installed', async () => {
    const controller = new AbortController();
    controller.abort();
    const server = serve(() => ok());
    const { host: h } = host({ download: downloadFromSource(FIXTURE), fetch: server.fetch });
    await expect(h.prepareRuntime({ dataDirectory: h.dataDirectory, download: true, signal: controller.signal })).rejects.toThrow();
    expect(runtimeLeftovers(h.dataDirectory)).toEqual([]);
  });

  it('has no download on a platform GitHub ships no runtime for, with a clear reason, and never touches the network', async () => {
    const server = serve(() => ok());
    const { host: h } = host({ platform: 'freebsd-x64', fetch: server.fetch });
    expect(h.canDownload).toBe(false);
    expect(h.downloadUnavailableReason).toContain('freebsd-x64');
    await expect(h.prepareRuntime({ dataDirectory: h.dataDirectory, download: true })).rejects.toBeInstanceOf(CopilotDownloadUnavailableError);
    expect(server.calls).toEqual([]);
  });

  it('with Copilot off nothing downloads: building the host and an ordinary start never touch the network', async () => {
    const server = serve(() => ok());
    const { host: h } = host({ fetch: server.fetch });
    expect(h.canDownload).toBe(true);
    await expect(h.prepareRuntime({ dataDirectory: h.dataDirectory, download: false })).rejects.toMatchObject({ response: { details: { check: 'runtime_missing' } } });
    expect(server.calls).toEqual([]);
  });

  it('prefers a bundled launcher and never downloads over it', async () => {
    const f = folder();
    const launcher = join(f.root, 'copilot-runtime');
    const server = serve(() => ok());
    const h = createDefaultCopilotHost({ folder: f, log: () => undefined, bundledRuntimePath: launcher, platform: PLATFORM, fetch: server.fetch });
    await expect(h.prepareRuntime({ dataDirectory: h.dataDirectory, download: true })).rejects.toBeDefined(); // the bundled file is missing: an error, never a silent download
    expect(server.calls).toEqual([]);
  });
});
