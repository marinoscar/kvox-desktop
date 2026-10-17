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
//
// THE CONSENT TURNS basic_text ON. With no keyring Electron reports encryption
// unavailable until `setUsePlainTextEncryption(true)`; that call follows the
// user's recorded consent before every operation, so `available` becomes true
// only once they accepted (marinoscar/kvox#584 found the gap). It is a no-op
// where a real keyring exists, and on macOS and Windows.
// =============================================================================

/** Lets Electron use `basic_text` exactly when the user accepted it (Linux only). */
function followConsent(settingsPath: string): boolean {
  const accepted = readShellSettings(settingsPath).secrets.allowPlaintext;
  if (process.platform === 'linux') safeStorage.setUsePlainTextEncryption(accepted);
  return accepted;
}

/** How keys are protected right now. */
export function secretStorageStatus(settingsPath: string): SecretStorageStatus {
  const plaintextAccepted = followConsent(settingsPath);
  return {
    available: safeStorage.isEncryptionAvailable(),
    backend: process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : null,
    plaintextAccepted,
  };
}

/** Answers one request of the server. */
export function runSecretOp(op: SecretOp, settingsPath: string): unknown {
  switch (op.op) {
    case 'status':
      return secretStorageStatus(settingsPath);
    case 'encrypt':
      followConsent(settingsPath);
      return safeStorage.encryptString(op.value).toString('base64');
    case 'decrypt':
      followConsent(settingsPath);
      return safeStorage.decryptString(Buffer.from(op.value, 'base64'));
  }
}
