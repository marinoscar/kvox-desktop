import { request as httpsRequest } from 'node:https';
import { createServer, connect, type AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { COPILOT_EGRESS_HOSTS } from '@marinoscar/kvox-ai/copilot';

import { COPILOT_CONSENT_VERSION } from '@marinoscar/kvox-contract/copilot';
import { COPILOT_RUNTIME_DOWNLOAD_HOSTS } from '../../src/server/ai/copilot-sandbox';
import { DEFAULT_DESKTOP_AI_SETTINGS, allowedHostsFor, type DesktopAiSettings } from '../../src/server/ai/desktop-ai-settings';
import { EgressBlockedError, EgressGuard, isLoopback } from '../../src/server/egress-guard';

// =============================================================================
// The server process's egress guard (marinoscar/kvox#583, ADR-0004)
// =============================================================================
//
// The guard the server installs at start-up, installed in this process: a
// request to example.com through `fetch`, `https` and a raw socket is refused
// and logged as an error with the host only; loopback still works. The window's
// guard is held to the same rule by tests/e2e/egress.spec.ts.
// =============================================================================

let guard: EgressGuard | undefined;
afterEach(() => guard?.uninstall());

function installed(lines: string[]): EgressGuard {
  guard = new EgressGuard({ logError: (line) => lines.push(line) });
  guard.install();
  return guard;
}

describe('EgressGuard', () => {
  it('blocks fetch to a host that is not allowed, and logs the host only', async () => {
    const lines: string[] = [];
    const g = installed(lines);
    const error = await fetch('https://example.com/private/path?token=secret').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(EgressBlockedError);
    expect(lines).toEqual(['egress blocked: example.com (1 blocked since start-up)']);
    expect(lines.join('\n')).not.toMatch(/private|token|secret|https/);
    expect(g.blocked).toBe(1);
  });

  it('blocks https.request and raw sockets, whatever agent is used', async () => {
    const lines: string[] = [];
    installed(lines);
    const viaHttps = await new Promise<unknown>((resolve) => {
      const req = httpsRequest({ host: 'example.com', path: '/x?y=z', agent: false }, () => resolve('connected'));
      req.on('error', resolve);
      req.end();
    });
    expect(viaHttps).toBeInstanceOf(EgressBlockedError);
    const viaSocket = await new Promise<unknown>((resolve) => {
      const socket = connect(80, 'example.com', () => resolve('connected'));
      socket.on('error', resolve);
    });
    expect(viaSocket).toBeInstanceOf(EgressBlockedError);
    expect(lines).toEqual([
      'egress blocked: example.com (1 blocked since start-up)',
      'egress blocked: example.com (2 blocked since start-up)',
    ]);
  });

  it('lets loopback through (the API server, PGlite, migrations)', async () => {
    const lines: string[] = [];
    installed(lines);
    const server = createServer((socket) => socket.end('pong'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      let data = '';
      socket.on('data', (chunk) => (data += chunk.toString()));
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
    server.close();
    expect(reply).toBe('pong');
    expect(lines).toEqual([]);
  });

  it('allows the configured AI provider host and follows a new allowlist', () => {
    const g = new EgressGuard({ logError: () => undefined });
    expect(g.isAllowed('api.openai.com')).toBe(true);
    expect(g.isAllowed('API.OpenAI.com.')).toBe(true);
    expect(g.isAllowed('example.com')).toBe(false);
    g.allow(['llm.internal.example']);
    expect(g.isAllowed('llm.internal.example')).toBe(true);
    expect(g.isAllowed('api.openai.com')).toBe(false);
    expect(g.isAllowed('127.0.0.1')).toBe(true);
  });

  it.each([
    ['127.0.0.1', true],
    ['127.12.0.9', true],
    ['localhost', true],
    ['::1', true],
    ['[::1]', true],
    ['::ffff:127.0.0.1', true],
    ['10.0.0.1', false],
    ['128.0.0.1', false],
    ['localhost.example.com', false],
  ])('isLoopback(%j) is %s', (host, expected) => {
    expect(isLoopback(host)).toBe(expected);
  });
});

describe('the Copilot hosts follow the provider (marinoscar/kvox-desktop#21)', () => {
  /** Copilot chosen, with the consent given (`enabled` is derived: provider === 'copilot'). */
  const copilot = (patch: Partial<DesktopAiSettings['copilot']> = {}): DesktopAiSettings => ({
    ...DEFAULT_DESKTOP_AI_SETTINGS,
    provider: 'copilot',
    copilot: { enabled: true, consentedAt: '2026-10-19T00:00:00.000Z', consentVersion: COPILOT_CONSENT_VERSION, model: null, ...patch },
  });
  const OPENAI = ['api.openai.com'];

  it('allows exactly the chosen provider host for OpenAI and for a compatible server', () => {
    expect(allowedHostsFor(DEFAULT_DESKTOP_AI_SETTINGS)).toEqual(OPENAI);
    // An OpenAI key changes nothing when OpenAI is the provider; the Copilot hosts are never added.
    expect(allowedHostsFor(DEFAULT_DESKTOP_AI_SETTINGS, { openaiKey: true })).toEqual(OPENAI);
    const compatible = (baseUrl: string): DesktopAiSettings => ({
      ...DEFAULT_DESKTOP_AI_SETTINGS,
      provider: 'openai-compatible',
      openaiCompatible: { ...DEFAULT_DESKTOP_AI_SETTINGS.openaiCompatible, baseUrl, model: 'm' },
    });
    expect(allowedHostsFor(compatible('https://llm.corp.example:8443/v1'), { openaiKey: true })).toEqual(['llm.corp.example']);
    expect(allowedHostsFor(compatible('http://127.0.0.1:11434/v1'))).toEqual([]);
    // A stale Copilot block next to another provider adds nothing.
    expect(allowedHostsFor({ ...copilot(), provider: 'openai' })).toEqual(OPENAI);
  });

  it('with Copilot chosen: the Copilot hosts, plus api.openai.com only when an OpenAI key is stored for Ask', () => {
    expect(allowedHostsFor(copilot())).toEqual([...COPILOT_EGRESS_HOSTS]);
    expect(allowedHostsFor(copilot(), { openaiKey: false })).toEqual([...COPILOT_EGRESS_HOSTS]);
    expect(allowedHostsFor(copilot(), { openaiKey: true })).toEqual([...COPILOT_EGRESS_HOSTS, ...OPENAI]);
  });

  it('needs the CURRENT consent: an older or missing consent adds no Copilot host (only OpenAI, once its key is stored)', () => {
    for (const stale of [{ consentedAt: null }, { consentVersion: '0-older' }, { consentVersion: null }]) {
      expect(allowedHostsFor(copilot(stale))).toEqual([]);
      expect(allowedHostsFor(copilot(stale), { openaiKey: true })).toEqual(OPENAI);
    }
  });

  it('adds the runtime download hosts only while Copilot is active and the download runs', () => {
    const withDownload = allowedHostsFor(copilot(), { runtimeDownload: true });
    expect(withDownload).toEqual([...COPILOT_EGRESS_HOSTS, ...COPILOT_RUNTIME_DOWNLOAD_HOSTS.filter((host) => !COPILOT_EGRESS_HOSTS.includes(host))]);
    expect(allowedHostsFor(copilot({ consentedAt: null }), { runtimeDownload: true })).toEqual([]);
    expect(allowedHostsFor(DEFAULT_DESKTOP_AI_SETTINGS, { runtimeDownload: true })).toEqual(OPENAI);
  });

  it('is what the guard enforces: the Copilot hosts connect only while Copilot is the provider', () => {
    const g = new EgressGuard({ logError: () => undefined });
    g.allow(allowedHostsFor(copilot()));
    for (const host of COPILOT_EGRESS_HOSTS) expect(g.isAllowed(host)).toBe(true);
    expect(g.isAllowed('api.openai.com')).toBe(false);
    expect(g.isAllowed('example.com')).toBe(false);
    g.allow(allowedHostsFor(DEFAULT_DESKTOP_AI_SETTINGS));
    for (const host of COPILOT_EGRESS_HOSTS) expect(g.isAllowed(host)).toBe(false);
    expect(g.isAllowed('api.openai.com')).toBe(true);
  });
});
