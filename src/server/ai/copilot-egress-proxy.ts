import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';

// =============================================================================
// The allowlisting CONNECT proxy for the Copilot runtime (marinoscar/kvox-desktop#23, ADR-0004)
// =============================================================================
//
// The Copilot runtime is a CHILD PROCESS, so the in-process egress guard
// (egress-guard.ts: an undici dispatcher plus a `net.Socket#connect` wrapper)
// cannot see its sockets. Its network access is forced through this proxy
// instead: the server starts the runtime with HTTPS_PROXY and HTTP_PROXY
// pointing at it (copilot-sandbox.ts) and NO_PROXY empty.
//
//   * Bound to 127.0.0.1 on a random port, never to another interface.
//   * HTTP CONNECT only, to `<allowed host>:443` (an exact hostname match, no
//     wildcard, no IP literal). Everything else, plain HTTP included, is refused
//     with 403 and logged.
//   * The proxy URL carries a random username and password, checked on every
//     CONNECT, so another program on this machine cannot borrow the tunnel to
//     the allowed hosts. (Verified: the runtime sends Proxy-Authorization.)
//   * Only the host and the port reach the log: never a path (a tunnel has none),
//     a header or a credential.
//   * The tunnel is opened with `net.connect` in THIS process, so the in-process
//     guard applies a second time: a host must be in COPILOT_EGRESS_HOSTS here
//     AND allowed by the guard (the host adds the Copilot hosts to the guard
//     while Copilot is enabled). The guard is never bypassed or weakened.
//
// The proxy does not terminate TLS and never sees a byte of the traffic.
// =============================================================================

/** Options of {@link startEgressProxy}. */
export interface EgressProxyOptions {
  /** The hostnames a tunnel may reach (exact match, case-insensitive). */
  allowedHosts: readonly string[];
  /** The ports a tunnel may reach. Default `[443]`. */
  allowedPorts?: readonly number[];
  /** Receives one line per refusal and per upstream failure (host and port only). */
  log: (line: string) => void;
  /** Opens the upstream socket (a test replaces it). Default `net.connect`. */
  connect?: (port: number, host: string) => net.Socket;
  /** Fails a tunnel that has not connected after this long. Default 15 s. */
  connectTimeoutMs?: number;
  /** Refuses new tunnels beyond this many open ones. Default 64. */
  maxTunnels?: number;
}

/** A running proxy. */
export interface EgressProxy {
  /** The port on 127.0.0.1. */
  readonly port: number;
  /** `http://<user>:<password>@127.0.0.1:<port>`: the value for HTTPS_PROXY and HTTP_PROXY. */
  readonly url: string;
  /** Tunnels refused since start. */
  readonly refused: number;
  /** Tunnels open now. */
  readonly openTunnels: number;
  /** Stops listening and destroys every open tunnel. Idempotent. */
  stop(): Promise<void>;
}

/** Lower-case, without a trailing dot. */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

/** What a log line may show of a request target: a host name or `?`, never anything else. */
function safeLabel(value: string): string {
  return /^[a-z0-9.-]{1,253}$/.test(value) ? value : '?';
}

/** Splits a CONNECT target `host:port` (no IPv6 literal: those are never allowed). */
function parseTarget(target: string): { host: string; port: number } | null {
  const match = /^([^:\s/@[\]]+):(\d{1,5})$/.exec(target);
  if (!match) return null;
  return { host: normalizeHost(match[1] as string), port: Number(match[2]) };
}

/** True when the Proxy-Authorization header carries the expected Basic credentials. */
function authorized(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith('Basic ')) return false;
  const given = Buffer.from(header.slice(6).trim(), 'base64');
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** Starts the proxy on 127.0.0.1, random port. */
export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const allowed = new Set(options.allowedHosts.map(normalizeHost));
  const ports = new Set(options.allowedPorts ?? [443]);
  const connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
  const maxTunnels = options.maxTunnels ?? 64;
  const open = options.connect ?? ((port: number, host: string) => net.connect({ port, host }));
  const username = 'kvox';
  const password = randomBytes(24).toString('hex');
  const credentials = `${username}:${password}`;

  let refused = 0;
  const sockets = new Set<Duplex>();
  let tunnels = 0;

  const refuse = (reason: string): void => {
    refused += 1;
    options.log(`copilot egress refused: ${reason} (${refused} refused since start)`);
  };

  const server = http.createServer((req, res) => {
    // A plain (non-CONNECT) request: the runtime reaches only https hosts, so none is legitimate.
    refuse(`plain HTTP request to ${safeLabel(normalizeHost((req.headers.host ?? '').split(':')[0] ?? ''))}`);
    res.writeHead(403, { 'content-type': 'text/plain', connection: 'close' });
    res.end('KVox Desktop refused this request: the Copilot runtime may only open HTTPS tunnels to its own hosts.\n');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  server.on('connect', (req, client: Duplex, head: Buffer) => {
    const reject = (status: string, reason: string): void => {
      refuse(reason);
      client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    };
    const target = parseTarget(req.url ?? '');
    if (!target) return reject('400 Bad Request', 'malformed CONNECT target');
    const label = `${safeLabel(target.host)}:${target.port}`;
    if (!authorized(req.headers['proxy-authorization'], credentials)) {
      return reject('407 Proxy Authentication Required', `CONNECT to ${label} without the proxy credentials`);
    }
    if (!allowed.has(target.host) || !ports.has(target.port)) return reject('403 Forbidden', `CONNECT to ${label}`);
    if (tunnels >= maxTunnels) return reject('503 Service Unavailable', `CONNECT to ${label}: too many open tunnels`);

    tunnels += 1;
    let counted = true;
    const release = (): void => {
      if (counted) tunnels -= 1;
      counted = false;
    };
    const upstream = open(target.port, target.host);
    sockets.add(upstream);
    const timer = setTimeout(() => upstream.destroy(new Error('connect timeout')), connectTimeoutMs);
    const finish = (): void => {
      clearTimeout(timer);
      release();
      sockets.delete(upstream);
      upstream.destroy();
      client.destroy();
    };
    upstream.once('connect', () => {
      clearTimeout(timer);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', (error: Error) => {
      // The in-process guard's refusal (EgressBlockedError) lands here as well.
      options.log(`copilot egress: tunnel to ${label} failed: ${(error as NodeJS.ErrnoException).code ?? error.name}`);
      if (client.writable && !upstream.readable) client.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    });
    upstream.on('close', finish);
    client.on('error', () => undefined);
    client.on('close', finish);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as net.AddressInfo).port;

  let stopped: Promise<void> | undefined;
  return {
    port,
    url: `http://${username}:${password}@127.0.0.1:${port}`,
    get refused() {
      return refused;
    },
    get openTunnels() {
      return tunnels;
    },
    stop() {
      stopped ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
        sockets.clear();
      });
      return stopped;
    },
  };
}
