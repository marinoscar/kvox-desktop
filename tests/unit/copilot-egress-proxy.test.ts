import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startEgressProxy, type EgressProxy } from '../../src/server/ai/copilot-egress-proxy';
import { runtimeEnvOverrides } from '../../src/server/ai/copilot-sandbox';

const ROOT = resolve(__dirname, '..', '..');

// =============================================================================
// The Copilot runtime's allowlisting CONNECT proxy (marinoscar/kvox-desktop#23, ADR-0004)
// =============================================================================
//
// The runtime is a child PROCESS, outside the in-process egress guard. A tiny
// probe process (tests/support/connect-probe.mjs) stands in for it: it finds the
// proxy in HTTPS_PROXY exactly as the runtime does and asks for a tunnel to one
// allowed and some forbidden hosts. The upstream is a local echo server, so no
// test needs the internet; the point is what the proxy answers and logs.
// =============================================================================

const ALLOWED = ['api.githubcopilot.com', 'github.com', 'api.github.com'];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function echoServer(): Promise<{ port: number; hits: () => number }> {
  let hits = 0;
  const server = net.createServer((socket) => {
    hits += 1;
    socket.on('data', (chunk) => socket.write(chunk));
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => (server.close(() => resolve()), (server as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.())));
  return { port: (server.address() as net.AddressInfo).port, hits: () => hits };
}

async function proxyTo(upstreamPort: number, extra: Partial<Parameters<typeof startEgressProxy>[0]> = {}) {
  const lines: string[] = [];
  const requested: string[] = [];
  const proxy = await startEgressProxy({
    allowedHosts: ALLOWED,
    log: (line) => lines.push(line),
    connect: (_port, host) => {
      requested.push(host);
      return net.connect({ port: upstreamPort, host: '127.0.0.1' });
    },
    ...extra,
  });
  cleanups.push(() => proxy.stop());
  return { proxy, lines, requested };
}

/** Runs the probe as a separate process with only the proxy variables set, like the runtime. */
function probe(proxy: EgressProxy, hosts: string[], env: Record<string, string> = {}): Promise<Array<{ host: string; status: number; echoed?: boolean }>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'tests', 'support', 'connect-probe.mjs'), ...hosts], {
      env: { PATH: process.env.PATH ?? '', ...runtimeEnvOverrides(proxy.url, '/unused'), ...env } as NodeJS.ProcessEnv,
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('error', reject);
    child.on('close', () => resolve(out.split('\n').filter(Boolean).map((line) => JSON.parse(line))));
  });
}

describe('the Copilot egress proxy', () => {
  it('listens on loopback only, on a random port, and stops listening on stop()', async () => {
    const { port } = await echoServer();
    const { proxy } = await proxyTo(port);
    const server = await new Promise<net.Socket>((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port: proxy.port }, () => resolve(socket));
      socket.on('error', reject);
    });
    expect(server.remoteAddress).toBe('127.0.0.1');
    expect(proxy.url).toMatch(/^http:\/\/kvox:[0-9a-f]{48}@127\.0\.0\.1:\d+$/);
    server.destroy();
    await proxy.stop();
    await expect(
      new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port: proxy.port });
        socket.on('connect', () => resolve('listening'));
        socket.on('error', reject);
      }),
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('tunnels an allowed host and refuses every other host, logging the host only', async () => {
    const echo = await echoServer();
    const { proxy, lines, requested } = await proxyTo(echo.port);
    const results = await probe(proxy, ['api.githubcopilot.com', 'evil.example.com', 'telemetry.github.com', '203.0.113.9', 'GITHUB.COM']);
    const by = Object.fromEntries(results.map((r) => [r.host, r]));
    expect(by['api.githubcopilot.com']).toMatchObject({ status: 200, echoed: true });
    expect(by['GITHUB.COM']).toMatchObject({ status: 200 });
    expect(by['evil.example.com']?.status).toBe(403);
    expect(by['telemetry.github.com']?.status).toBe(403); // no wildcard, no sub-domain
    expect(by['203.0.113.9']?.status).toBe(403); // no IP literal
    // Only the allowed hosts were ever dialled upstream.
    expect(requested.sort()).toEqual(['api.githubcopilot.com', 'github.com']);
    expect(proxy.refused).toBe(3);
    const refusals = lines.filter((line) => line.startsWith('copilot egress refused'));
    expect(refusals).toHaveLength(3);
    expect(refusals.join('\n')).toContain('evil.example.com:443');
    // Never the credentials, never a header.
    const all = lines.join('\n');
    expect(all).not.toContain(proxy.url.split('@')[0]!.split(':')[2]!);
    expect(all).not.toMatch(/Proxy-Authorization|Basic /i);
  });

  it('refuses a port other than 443', async () => {
    const echo = await echoServer();
    const { proxy, lines } = await proxyTo(echo.port);
    const status = await new Promise<number>((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port: proxy.port }, () => {
        const credentials = Buffer.from(decodeURIComponent(proxy.url.slice(7, proxy.url.indexOf('@')))).toString('base64');
        socket.write(`CONNECT github.com:22 HTTP/1.1\r\nHost: github.com:22\r\nProxy-Authorization: Basic ${credentials}\r\n\r\n`);
      });
      socket.on('data', (chunk) => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(chunk.toString())?.[1])));
    });
    expect(status).toBe(403);
    expect(lines.join('\n')).toContain('CONNECT to github.com:22');
    expect(echo.hits()).toBe(0);
  });

  it('refuses a caller without the proxy credentials (another program on this machine)', async () => {
    const echo = await echoServer();
    const { proxy, lines } = await proxyTo(echo.port);
    const [result] = await probe(proxy, ['github.com'], { PROBE_NO_CREDENTIALS: '1' });
    expect(result?.status).toBe(407);
    expect(echo.hits()).toBe(0);
    expect(lines.join('\n')).toContain('without the proxy credentials');
  });

  it('refuses a plain HTTP request', async () => {
    const echo = await echoServer();
    const { proxy, lines } = await proxyTo(echo.port);
    const status = await new Promise<number>((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: proxy.port, path: 'http://github.com/', headers: { host: 'github.com' } }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on('error', reject);
      request.end();
    });
    expect(status).toBe(403);
    expect(lines.join('\n')).toContain('plain HTTP request to github.com');
    expect(echo.hits()).toBe(0);
  });

  it('answers 502 and logs the failure when the upstream cannot be reached (the in-process guard, for one)', async () => {
    const { proxy, lines } = await proxyTo(0, {
      connect: () => {
        const socket = new net.Socket();
        process.nextTick(() => socket.destroy(Object.assign(new Error('KVox Desktop blocked a connection to github.com'), { code: 'KVOX_EGRESS_BLOCKED' })));
        return socket;
      },
    });
    const [result] = await probe(proxy, ['github.com']);
    expect(result?.status).toBe(502);
    expect(lines.join('\n')).toContain('tunnel to github.com:443 failed: KVOX_EGRESS_BLOCKED');
  });

  it('destroys open tunnels on stop()', async () => {
    const echo = await echoServer();
    const { proxy } = await proxyTo(echo.port);
    const credentials = Buffer.from(decodeURIComponent(proxy.url.slice(7, proxy.url.indexOf('@')))).toString('base64');
    const socket = net.connect({ host: '127.0.0.1', port: proxy.port });
    await new Promise<void>((resolve) => {
      socket.on('connect', () => socket.write(`CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\nProxy-Authorization: Basic ${credentials}\r\n\r\n`));
      socket.on('data', () => resolve());
    });
    expect(proxy.openTunnels).toBe(1);
    const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
    await proxy.stop();
    await closed;
    expect(proxy.openTunnels).toBe(0);
  });
});
