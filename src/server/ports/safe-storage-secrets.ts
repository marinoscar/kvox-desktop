import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { ConflictException, ServiceUnavailableException } from '@nestjs/common';

import type { KvoxSecretStatus, KvoxSecretsPort } from '@marinoscar/kvox-api/ports';

import type { SecretStorageStatus } from '../../shared/protocol';

// =============================================================================
// SafeStorageSecrets: KVOX_SECRETS as Electron `safeStorage` blobs (marinoscar/kvox#583)
// =============================================================================
//
// Every value is encrypted by the operating system's secret store (macOS
// Keychain, Windows DPAPI, the Linux Secret Service or KWallet) through
// Electron's `safeStorage`, and only the resulting blob rests on disk, in
// `<userData>/secrets.bin` (JSON, one base64 blob per `purpose/name`, written
// whole through a temporary file and a rename, mode 0600).
//
// `safeStorage` lives in the MAIN process; this class runs in the server
// utility process, so the encryption is a {@link SecretCipher} (the main
// process over the utility-process port in the app, a fake in the tests).
//
// THE LINUX RULE. With no keyring, Electron falls back to the `basic_text`
// backend: a key hard-coded in Chromium, which is plaintext in all but name.
// `set` REFUSES to store then (409, {@link PlaintextSecretsRefusedError}) until
// the user has accepted the warning in Settings (the main process keeps that
// consent in `settings.json`). Nothing is ever written in the clear silently.
//
// Never logged: values, blobs, hints. `status` returns whether a value is set,
// a short hint (the last four characters of a long value, kept beside the blob
// so a status read does not decrypt) and when it changed.
// =============================================================================

/** The encryption the main process offers (Electron `safeStorage`). */
export interface SecretCipher {
  /** Which backend encrypts and whether the user accepted plaintext storage. */
  status(): Promise<SecretStorageStatus>;
  /** Encrypts a value; answers the blob as base64. */
  encrypt(plaintext: string): Promise<string>;
  /** Decrypts a base64 blob. */
  decrypt(blob: string): Promise<string>;
}

/** The warning `set` refuses with on a Linux session with no keyring. */
export const PLAINTEXT_SECRETS_WARNING =
  'No system keyring is available (Electron safeStorage reports the "basic_text" backend), so a saved key would be ' +
  'stored without real encryption. Install or unlock a keyring (GNOME Keyring, KWallet), or accept plaintext storage ' +
  'in Settings > Data and privacy, then save the key again.';

/** Thrown by `set` when only the `basic_text` backend is available and the user has not accepted it. */
export class PlaintextSecretsRefusedError extends ConflictException {
  constructor() {
    super({ message: PLAINTEXT_SECRETS_WARNING, code: 'secret_storage_plaintext' });
  }
}

/** True when the cipher would store a value without real encryption and the user has not accepted that. */
export function refusesPlaintext(status: SecretStorageStatus): boolean {
  return status.backend === 'basic_text' && !status.plaintextAccepted;
}

interface StoredSecret {
  blob: string;
  hint: string | null;
  label: string | null;
  updatedAt: string;
  updatedByUserId: string;
}

interface SecretsFile {
  version: 1;
  secrets: Record<string, StoredSecret>;
}

/** Options of {@link SafeStorageSecrets}. */
export interface SafeStorageSecretsOptions {
  /** `<userData>/secrets.bin`. */
  file: string;
  /** The main process's `safeStorage`. */
  cipher: SecretCipher;
  /** Receives one line when a blob no longer decrypts (never the value). */
  log?: (line: string) => void;
}

/** KVOX_SECRETS over `safeStorage` blobs in one file. */
export class SafeStorageSecrets implements KvoxSecretsPort {
  private readonly purposes = new Map<string, string>();
  private readonly file: string;
  private readonly cipher: SecretCipher;
  private readonly log: (line: string) => void;

  constructor(options: SafeStorageSecretsOptions) {
    this.file = options.file;
    this.cipher = options.cipher;
    this.log = options.log ?? (() => undefined);
  }

  registerPurpose(purpose: string, label: string): void {
    this.purposes.set(purpose, label);
  }

  private address(purpose: string, name: string): string {
    if (!this.purposes.has(purpose)) throw new Error(`Credential purpose "${purpose}" is not registered`);
    return `${purpose}/${name}`;
  }

  private load(): SecretsFile {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<SecretsFile>;
      return { version: 1, secrets: parsed.secrets ?? {} };
    } catch {
      return { version: 1, secrets: {} };
    }
  }

  private save(document: SecretsFile): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.file);
  }

  async get(purpose: string, name: string): Promise<string | null> {
    const key = this.address(purpose, name);
    const entry = this.load().secrets[key];
    if (!entry) return null;
    try {
      return await this.cipher.decrypt(entry.blob);
    } catch {
      // A blob from another machine or user account, or a keyring that was reset.
      this.log(`secrets: the stored value of ${key} can no longer be decrypted; it reads as not set`);
      return null;
    }
  }

  async set(purpose: string, name: string, value: string, actorUserId: string, meta?: { label?: string }): Promise<void> {
    const key = this.address(purpose, name);
    const status = await this.cipher.status();
    if (!status.available) throw new ServiceUnavailableException('The operating system offers no way to encrypt a saved key');
    if (refusesPlaintext(status)) throw new PlaintextSecretsRefusedError();
    const blob = await this.cipher.encrypt(value);
    const document = this.load();
    document.secrets[key] = {
      blob,
      hint: value.length > 8 ? `…${value.slice(-4)}` : null,
      label: meta?.label ?? null,
      updatedAt: new Date().toISOString(),
      updatedByUserId: actorUserId,
    };
    this.save(document);
  }

  async delete(purpose: string, name: string): Promise<void> {
    const key = this.address(purpose, name);
    const document = this.load();
    if (!(key in document.secrets)) return;
    delete document.secrets[key];
    this.save(document);
  }

  async status(purpose: string, name: string): Promise<KvoxSecretStatus> {
    const entry = this.load().secrets[this.address(purpose, name)];
    if (!entry) return { configured: false, hint: null, updatedAt: null };
    return { configured: true, hint: entry.hint, updatedAt: entry.updatedAt, updatedByUserId: entry.updatedByUserId };
  }
}
