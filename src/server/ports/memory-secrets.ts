// Copied from marinoscar/kvox examples/bare-host/src/ports/memory-secrets.ts (kvox commit in vendor/kvox/SOURCE.json). A host binding; keep it in step with the bare host.
import type { KvoxSecretStatus, KvoxSecretsPort } from '@marinoscar/kvox-api/ports';

// =============================================================================
// MemorySecrets: KVOX_SECRETS in a Map
// =============================================================================
//
// What KVox Desktop replaces with the operating-system keychain (the user's
// secret store is the only place a provider key may rest). This host keeps the
// values in memory, so they die with the process; the seed sets them again on
// every start. `status` never returns material, only whether a value is set, a
// short hint, and when it changed: the same contract the web edition's
// encrypted credential store keeps.
// =============================================================================

interface Held {
  value: string;
  label: string | null;
  updatedAt: string;
  updatedByUserId: string;
}

/** KVOX_SECRETS in memory. */
export class MemorySecrets implements KvoxSecretsPort {
  private readonly purposes = new Map<string, string>();
  private readonly held = new Map<string, Held>();

  registerPurpose(purpose: string, label: string): void {
    this.purposes.set(purpose, label);
  }

  private address(purpose: string, name: string): string {
    if (!this.purposes.has(purpose)) throw new Error(`Credential purpose "${purpose}" is not registered`);
    return `${purpose}/${name}`;
  }

  async get(purpose: string, name: string): Promise<string | null> {
    return this.held.get(this.address(purpose, name))?.value ?? null;
  }

  async set(purpose: string, name: string, value: string, actorUserId: string, meta?: { label?: string }): Promise<void> {
    this.held.set(this.address(purpose, name), {
      value,
      label: meta?.label ?? null,
      updatedAt: new Date().toISOString(),
      updatedByUserId: actorUserId,
    });
  }

  async delete(purpose: string, name: string): Promise<void> {
    this.held.delete(this.address(purpose, name));
  }

  async status(purpose: string, name: string): Promise<KvoxSecretStatus> {
    const entry = this.held.get(this.address(purpose, name));
    if (!entry) return { configured: false, hint: null, updatedAt: null };
    return {
      configured: true,
      hint: entry.value.length > 8 ? `…${entry.value.slice(-4)}` : null,
      updatedAt: entry.updatedAt,
      updatedByUserId: entry.updatedByUserId,
    };
  }
}
