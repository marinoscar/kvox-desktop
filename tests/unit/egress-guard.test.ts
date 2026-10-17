import { request as httpsRequest } from 'node:https';
import { createServer, connect, type AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

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
