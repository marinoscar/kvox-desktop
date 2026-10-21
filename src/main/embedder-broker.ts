import type { EmbedderRequest, EmbedderResponse } from '../shared/protocol';

// =============================================================================
// The embedder broker: main process <-> the embedder utility process (marinoscar/kvox#660)
// =============================================================================
//
// The on-device embedding model BLOCKS the event loop of whatever process runs it
// (about 0.5 s per chunk), so it runs in a utility process of its own
// (`embedder.ts`), never in the server's. Only the main process may fork
// (the RunAsNode fuse is off), so the server's `embed` request reaches that process
// through this broker.
//
//   LAZY       forked on the first request. With local search off nothing exists.
//   KEPT       alive between requests (loading the model takes about a second).
//   IDLE-KILL  killed after `idleMs` with nothing in flight, to give the memory
//              back (the model is about 120 MB resident); the next request forks anew.
//   DEATH      when the process dies (a crash, the OS, an out-of-memory kill) every
//              request in flight fails with a readable error and the next request
//              starts a new process. A request that takes longer than `requestTimeoutMs`
//              kills the process the same way (a wedged model never wedges the server).
//   ORDER      requests are queued by the embedder itself, one batch at a time.
//
// The broker holds no model logic and sees only texts and vectors, which it
// passes through; nothing is logged but counts and reasons.
// =============================================================================

/** The part of an Electron `UtilityProcess` the broker uses (a fake in the tests). */
export interface EmbedderChild {
  postMessage(message: EmbedderRequest): void;
  kill(): unknown;
  on(event: 'message', listener: (message: EmbedderResponse) => void): unknown;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
}

/** Options of {@link EmbedderBroker}. */
export interface EmbedderBrokerOptions {
  /** Forks the embedder utility process. */
  fork(): EmbedderChild;
  /** Idle time before the process is killed. Default 5 minutes. */
  idleMs?: number;
  /** The longest one request may take. Default 2 minutes. */
  requestTimeoutMs?: number;
  log?: (line: string) => void;
}

interface Waiting {
  resolve: (vectors: number[][]) => void;
  reject: (error: Error) => void;
}

/** The embedder process's keeper. */
export class EmbedderBroker {
  private child: EmbedderChild | null = null;
  private nextId = 1;
  private readonly inFlight = new Map<number, Waiting>();
  private idleTimer: NodeJS.Timeout | null = null;
  private requestTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly options: EmbedderBrokerOptions) {}

  /** Whether an embedder process exists now. */
  get running(): boolean {
    return this.child !== null;
  }

  /** Requests currently waiting for the embedder. */
  get pending(): number {
    return this.inFlight.size;
  }

  /** Embeds `texts` with the model at `modelPath`. Rejects with the embedder's own message, or when the process dies. */
  request(modelPath: string, texts: string[]): Promise<number[][]> {
    if (this.closed) return Promise.reject(new Error('The on-device embedder is shut down'));
    this.clearIdle();
    const child = this.child ?? this.start();
    const id = this.nextId++;
    return new Promise<number[][]>((resolve, reject) => {
      this.inFlight.set(id, { resolve, reject });
      this.armRequestTimer();
      try {
        child.postMessage({ id, modelPath, texts });
      } catch (error) {
        this.inFlight.delete(id);
        this.afterSettle();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** App quit (or the server stopped): kills the process and fails what is in flight. After this the broker refuses requests until {@link reopen}. */
  shutdown(): void {
    this.closed = true;
    this.clearIdle();
    this.clearRequestTimer();
    this.killChild('the on-device embedder was shut down');
  }

  /** Lets requests through again (the server restarted after a restore). */
  reopen(): void {
    this.closed = false;
  }

  private start(): EmbedderChild {
    const child = this.options.fork();
    this.child = child;
    this.options.log?.('embedder: process started');
    child.on('message', (message) => {
      if (this.child !== child) return;
      const waiting = this.inFlight.get(message.id);
      if (!waiting) return;
      this.inFlight.delete(message.id);
      if ('error' in message) waiting.reject(new Error(message.error));
      else waiting.resolve(message.vectors);
      this.afterSettle();
    });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.clearIdle();
      this.clearRequestTimer();
      this.options.log?.(`embedder: process exited (code ${code})`);
      this.failAll(`The on-device embedder stopped unexpectedly (code ${code})`);
    });
    return child;
  }

  /** A request ended: re-arm the watchdog for what is left, or start the idle clock. */
  private afterSettle(): void {
    this.clearRequestTimer();
    if (this.inFlight.size > 0) this.armRequestTimer();
    else this.armIdle();
  }

  private armRequestTimer(): void {
    this.clearRequestTimer();
    this.requestTimer = setTimeout(() => {
      this.requestTimer = null;
      this.options.log?.('embedder: a request timed out; killing the process');
      this.killChild('The on-device embedder did not answer in time');
    }, this.options.requestTimeoutMs ?? 2 * 60_000);
    this.requestTimer.unref?.();
  }

  private armIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.inFlight.size > 0) return;
      this.options.log?.('embedder: idle; stopping the process to free memory');
      this.killChild('idle');
    }, this.options.idleMs ?? 5 * 60_000);
    this.idleTimer.unref?.();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private clearRequestTimer(): void {
    if (this.requestTimer) clearTimeout(this.requestTimer);
    this.requestTimer = null;
  }

  /** Kills the process now (its `exit` event is then ignored) and fails everything in flight. */
  private killChild(reason: string): void {
    const child = this.child;
    this.child = null;
    this.clearRequestTimer();
    if (child) {
      try {
        child.kill();
      } catch {
        // already gone
      }
    }
    this.failAll(reason);
  }

  private failAll(reason: string): void {
    const waiting = [...this.inFlight.values()];
    this.inFlight.clear();
    for (const entry of waiting) entry.reject(new Error(reason));
  }
}
