import type { FromServer, SecretOp, SecretStorageStatus, ToServer } from '../shared/protocol';
import type { SecretCipher } from './ports/safe-storage-secrets.js';

// =============================================================================
// What the server asks of the main process (marinoscar/kvox#583)
// =============================================================================
//
// `safeStorage` and `Notification` exist only in Electron's main process. The
// server reaches them over its utility-process port: a `secrets` request
// carries an id and the main process answers `secrets-result` with the same
// id. Requests time out after 30 s (a keyring prompt the user ignores).
// =============================================================================

const TIMEOUT_MS = 30_000;

/** The server's side of the main-process services. */
export class MainBridge {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly send: (message: FromServer) => void) {}

  /** Routes a `secrets-result`; answers false for any other message. */
  handle(message: ToServer): boolean {
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

  notify(title: string, body: string): void {
    this.send({ type: 'notify', title, body });
  }

  restart(reason: string): void {
    this.send({ type: 'restart', reason });
  }
}
