import { safeStorage } from 'electron';

import type { SecretOp, SecretStorageStatus } from '../shared/protocol';
import { readShellSettings } from './shell-settings';

// =============================================================================
// `safeStorage` for the server's KVOX_SECRETS (marinoscar/kvox#583)
// =============================================================================
//
// The server holds the blobs (`secrets.bin`); this process only encrypts and
// decrypts, because `safeStorage` exists only here. The refusal to store with
// Linux's `basic_text` backend is the server adapter's (`refusesPlaintext`),
// given the status answered here; values never pass through a log.
// =============================================================================

/** How keys are protected right now. */
export function secretStorageStatus(settingsPath: string): SecretStorageStatus {
  return {
    available: safeStorage.isEncryptionAvailable(),
    backend: process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : null,
    plaintextAccepted: readShellSettings(settingsPath).secrets.allowPlaintext,
  };
}

/** Answers one request of the server. */
export function runSecretOp(op: SecretOp, settingsPath: string): unknown {
  switch (op.op) {
    case 'status':
      return secretStorageStatus(settingsPath);
    case 'encrypt':
      return safeStorage.encryptString(op.value).toString('base64');
    case 'decrypt':
      return safeStorage.decryptString(Buffer.from(op.value, 'base64'));
  }
}
