import net from 'node:net';

import { Agent, buildConnector, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';

// =============================================================================
// The server's egress guard (marinoscar/kvox#583, ADR-0004)
// =============================================================================
//
// The server process may reach loopback and the configured AI provider's host,
// nothing else. Two layers, both installed once at start-up:
//
//   1. FETCH: a global undici dispatcher (`setGlobalDispatcher`) whose connector
//      refuses a host that is not allowed. Node's `fetch` (and the AI SDKs on
//      top of it) fail with a clear {@link EgressBlockedError}.
//   2. EVERY OTHER SOCKET: `net.Socket.prototype.connect` is wrapped, so
//      `http`/`https` (whatever agent a library passes), `tls` and raw `net`
//      connections are held to the same allowlist. A refused socket is
//      destroyed with the same error.
//
// Loopback (127.0.0.0/8, ::1, `localhost`) and local sockets (pipes, Unix
// domain sockets) are always allowed: the API server, PGlite's socket and the
// migration commands live there. Every block is an error-level log line with
// the HOST ONLY (never a path, a query or a header) and is counted.
//
// The allowlist starts as `api.openai.com`; `allow()` replaces it when the AI
// settings change (the configured OpenAI-compatible base URL's host; the
// Copilot hosts once marinoscar/kvox#581 lands). Wiring the provider settings
// to it is D3 (marinoscar/kvox#584).
// =============================================================================

/** The hosts allowed before the AI settings are read. */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = ['api.openai.com'];

/** The error a refused connection fails with. */
export class EgressBlockedError extends Error {
  readonly code = 'KVOX_EGRESS_BLOCKED';

  constructor(readonly host: string) {
    super(`KVox Desktop blocked a connection to ${host}: only the configured AI provider may be reached`);
    this.name = 'EgressBlockedError';
  }
}

/** Lower-case, without IPv6 brackets or a trailing dot. */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
}

/** True for a loopback name or address. */
export function isLoopback(host: string): boolean {
  const name = normalizeHost(host);
  if (name === 'localhost' || name === '::1' || name === '0:0:0:0:0:0:0:1') return true;
  const v4 = name.startsWith('::ffff:') ? name.slice(7) : name;
  return net.isIPv4(v4) && v4.startsWith('127.');
}

/** Where a `Socket#connect` call is going: a host, or `null` for a local socket (a path). */
function targetOf(args: unknown[]): string | null {
  let first = args[0];
  // Node's own callers (net.connect, tls.connect) pass the normalized [options, callback] array.
  if (Array.isArray(first)) first = first[0];
  if (typeof first === 'object' && first !== null) {
    const options = first as { path?: unknown; host?: unknown };
    if (typeof options.path === 'string') return null;
    return typeof options.host === 'string' && options.host !== '' ? options.host : 'localhost';
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return null; // connect(path)
  return typeof args[1] === 'string' && args[1] !== '' ? args[1] : 'localhost'; // connect(port, host?)
}

/** Options of {@link EgressGuard}. */
export interface EgressGuardOptions {
  /** The non-loopback hosts that may be reached. */
  allowedHosts?: readonly string[];
  /** Receives the error line of every block. */
  logError: (line: string) => void;
}

/** The allowlist and its two enforcement layers. */
export class EgressGuard {
  private allowed: Set<string>;
  private blockedCount = 0;
  private installed: { dispatcher: Dispatcher; connect: typeof net.Socket.prototype.connect } | null = null;

  constructor(private readonly options: EgressGuardOptions) {
    this.allowed = new Set((options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS).map(normalizeHost));
  }

  /** Replaces the allowlist (loopback stays allowed). */
  allow(hosts: readonly string[]): void {
    this.allowed = new Set(hosts.map(normalizeHost));
  }

  /** The current allowlist, for the start-up log. */
  get allowedHosts(): string[] {
    return [...this.allowed];
  }

  /** How many connections were refused since start-up. */
  get blocked(): number {
    return this.blockedCount;
  }

  isAllowed(host: string): boolean {
    return isLoopback(host) || this.allowed.has(normalizeHost(host));
  }

  /** Checks a host; a refusal is logged (host only), counted and answered as an error. */
  check(host: string): EgressBlockedError | null {
    if (this.isAllowed(host)) return null;
    this.blockedCount += 1;
    const name = normalizeHost(host);
    this.options.logError(`egress blocked: ${name} (${this.blockedCount} blocked since start-up)`);
    return new EgressBlockedError(name);
  }

  /** Installs both layers in this process. Idempotent. */
  install(): void {
    if (this.installed) return;
    const guard = this;
    const baseConnect = buildConnector({});
    const connector: buildConnector.connector = (options, callback) => {
      const refused = guard.check(options.hostname);
      if (refused) {
        callback(refused, null);
        return;
      }
      baseConnect(options, callback);
    };
    const dispatcher = getGlobalDispatcher();
    setGlobalDispatcher(new Agent({ connect: connector }));

    const connect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
      const host = targetOf(args);
      const refused = host === null ? null : guard.check(host);
      if (refused) {
        process.nextTick(() => this.destroy(refused));
        return this;
      }
      return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
    } as typeof net.Socket.prototype.connect;
    this.installed = { dispatcher, connect };
  }

  /** Removes both layers (the tests). */
  uninstall(): void {
    if (!this.installed) return;
    setGlobalDispatcher(this.installed.dispatcher);
    net.Socket.prototype.connect = this.installed.connect;
    this.installed = null;
  }
}
