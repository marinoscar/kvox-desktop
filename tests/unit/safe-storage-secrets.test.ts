import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PLAINTEXT_SECRETS_WARNING, PlaintextSecretsRefusedError, SafeStorageSecrets } from '../../src/server/ports/safe-storage-secrets';
import { fakeCipher } from './support/database';

// =============================================================================
// KVOX_SECRETS over safeStorage blobs: the Linux no-keyring rule (marinoscar/kvox#583)
// =============================================================================

const VALUE = 'sk-desktop-test-0123456789abcdef';

function secrets(status: Parameters<typeof fakeCipher>[0]) {
  const file = join(mkdtempSync(join(tmpdir(), 'kvox-secrets-')), 'secrets.bin');
  const port = new SafeStorageSecrets({ file, cipher: fakeCipher(status) });
  port.registerPurpose('ai', 'AI provider');
  return { port, file };
}

describe('SafeStorageSecrets', () => {
  it('on a Linux session with no keyring (basic_text), refuses with the warning and stores nothing', async () => {
    const { port, file } = secrets({ backend: 'basic_text', plaintextAccepted: false });
    const refusal = await port.set('ai', 'openai', VALUE, 'user-1').catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PlaintextSecretsRefusedError);
    expect((refusal as PlaintextSecretsRefusedError).getStatus()).toBe(409);
    expect((refusal as PlaintextSecretsRefusedError).getResponse()).toEqual({ message: PLAINTEXT_SECRETS_WARNING, code: 'secret_storage_plaintext' });
    expect(PLAINTEXT_SECRETS_WARNING).toMatch(/keyring/);
    expect(existsSync(file)).toBe(false);
    expect((await port.status('ai', 'openai')).configured).toBe(false);
  });

  it('stores with basic_text once the user accepted the warning', async () => {
    const { port } = secrets({ backend: 'basic_text', plaintextAccepted: true });
    await port.set('ai', 'openai', VALUE, 'user-1');
    expect(await port.get('ai', 'openai')).toBe(VALUE);
  });

  it('keeps only the encrypted blob on disk, never the value', async () => {
    const { port, file } = secrets({ backend: 'gnome_libsecret' });
    await port.set('ai', 'openai', VALUE, 'user-1', { label: 'Work key' });
    const onDisk = readFileSync(file, 'utf8');
    expect(onDisk).not.toContain(VALUE);
    expect(JSON.parse(onDisk).secrets['ai/openai']).toMatchObject({ hint: '…cdef', label: 'Work key', updatedByUserId: 'user-1' });
    expect(await port.status('ai', 'openai')).toMatchObject({ configured: true, hint: '…cdef' });
    await port.delete('ai', 'openai');
    expect(await port.get('ai', 'openai')).toBeNull();
  });

  it('refuses when the OS offers no encryption at all', async () => {
    const { port } = secrets({ available: false });
    await expect(port.set('ai', 'openai', VALUE, 'user-1')).rejects.toThrow(/no way to encrypt/);
  });

  it('reads a blob that no longer decrypts as not set, without logging the value', async () => {
    const lines: string[] = [];
    const file = join(mkdtempSync(join(tmpdir(), 'kvox-secrets-')), 'secrets.bin');
    const writer = new SafeStorageSecrets({ file, cipher: fakeCipher() });
    writer.registerPurpose('ai', 'AI');
    await writer.set('ai', 'openai', VALUE, 'user-1');
    const broken = { ...fakeCipher(), decrypt: async () => Promise.reject(new Error('keyring reset')) };
    const reader = new SafeStorageSecrets({ file, cipher: broken, log: (line) => lines.push(line) });
    reader.registerPurpose('ai', 'AI');
    expect(await reader.get('ai', 'openai')).toBeNull();
    expect(lines.join('\n')).not.toContain(VALUE);
  });
});
