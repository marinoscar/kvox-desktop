import type { FromServer, SecretOp, SecretStorageStatus, ToServer } from '../shared/protocol';
import type { NodeScriptRunner } from './database.js';
import type { SecretCipher } from './ports/safe-storage-secrets.js';

// =============================================================================
// What the server asks of the main process (marinoscar/kvox#583)
// =============================================================================
//
// `safeStorage` and `Notification` exist only in Electron's main process. The
// server reaches them over its utility-process port: a `secrets` request
// carries an id and the main process answers `secrets-result` with the same
// id. Requests time out after 30 s (a keyring prompt the user ignores).
//
// A migration command (`run-node`) is the same pattern without a timeout: the
// main process forks a utility process, which ends on its own (marinoscar/kvox#587).
//
// An `embed` request (marinoscar/kvox#660) is answered by `embed-result`: the main
// process forwards the texts to the long-lived embedder utility process, which
// blocks its own event loop while the model runs (never the server's).
// =============================================================================

const TIMEOUT_MS = 30_000;

/** The longest an embed request waits: loading the model plus 32 chunks is well under a minute; this is the backstop. */
const EMBED_TIMEOUT_MS = 5 * 60_000;

/** The server's side of the main-process services. */
export class MainBridge {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly send: (message: FromServer) => void) {}

  private readonly embeds = new Map<number, { resolve: (vectors: number[][]) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  private readonly scripts = new Map<number, (result: { code: number | null; output: string }) => void>();

  /** Routes a `secrets-result` or a `run-node-result`; answers false for any other message. */
  handle(message: ToServer): boolean {
    if (message.type === 'run-node-result') {
      this.scripts.get(message.id)?.({ code: message.code, output: message.output });
      this.scripts.delete(message.id);
      return true;
    }
    if (message.type === 'embed-result') {
      const waiting = this.embeds.get(message.id);
      if (!waiting) return true;
      this.embeds.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.ok) waiting.resolve(message.vectors);
      else waiting.reject(new Error(message.error));
      return true;
    }
    if (message.type !== 'secrets-result') return false;
    const waiting = this.pending.get(message.id);
    if (!waiting) return true;
    this.pending.delete(message.id);
    clearTimeout(waiting.timer);
    if (message.ok) waiting.resolve(message.value);
    else waiting.reject(new Error(message.error));
    return true;
  }

  private ask<T>(op: SecretOp): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The system keyring did not answer in time'));
      }, TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.send({ type: 'secrets', id, ...op });
    });
  }

  /** `safeStorage`, through the main process. */
  readonly cipher: SecretCipher = {
    status: () => this.ask<SecretStorageStatus>({ op: 'status' }),
    encrypt: (value) => this.ask<string>({ op: 'encrypt', value }),
    decrypt: (value) => this.ask<string>({ op: 'decrypt', value }),
  };

  /** A Node script in a utility process of the main process's. */
  readonly runNodeScript: NodeScriptRunner = (request) => {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.scripts.set(id, resolve);
      this.send({ type: 'run-node', id, ...request });
    });
  };

  /** Embeds `texts` with the on-device model installed at `modelPath`, in the main process's embedder utility process. */
  readonly embed = (modelPath: string, texts: string[]): Promise<number[][]> => {
    const id = this.nextId++;
    return new Promise<number[][]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.embeds.delete(id);
        reject(new Error('The on-device embedder did not answer in time'));
      }, EMBED_TIMEOUT_MS);
      timer.unref();
      this.embeds.set(id, { resolve, reject, timer });
      this.send({ type: 'embed', id, modelPath, texts });
    });
  };

  notify(title: string, body: string): void {
    this.send({ type: 'notify', title, body });
  }

  restart(reason: string): void {
    this.send({ type: 'restart', reason });
  }
}
