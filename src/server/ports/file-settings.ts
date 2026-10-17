// Copied from marinoscar/kvox examples/bare-host/src/ports/file-settings.ts (kvox commit in vendor/kvox/SOURCE.json). A host binding; keep it in step with the bare host.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type {
  KvoxReadSystemOptions,
  KvoxSettingsNamespaceDef,
  KvoxSettingsPort,
  KvoxVersionedSettings,
} from '@marinoscar/kvox-api/ports';

// =============================================================================
// FileSettings: KVOX_SETTINGS in one JSON file
// =============================================================================
//
// What KVox Desktop takes as a starting point (it may keep the same file in the
// user's application-data folder, or a table). The domain declares namespaces
// (`registerNamespace`: the system `transcription` policy, the per-user `graph`
// preferences); this class stores one value per namespace and, for the system
// scope, a version that a patch can be made conditional on (`ifMatchVersion`).
//
//   - A namespace nobody has written reads as its defaults at version 0 (the web
//     edition's behaviour: a read never creates a row).
//   - A patch is a JSON Merge Patch over the stored value (objects merge,
//     everything else replaces), and the result must pass the namespace's schema
//     before anything is written.
//   - The file is rewritten whole through a temporary file and a rename, so a
//     crash never leaves half a document.
//
// A SECRET IS NEVER A SETTING: provider keys go through the secrets port.
// =============================================================================

interface SystemEntry {
  value: unknown;
  version: number;
  updatedAt: string;
}

interface Document {
  system: Record<string, SystemEntry>;
  user: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** RFC 7386: objects merge key by key, any other value replaces. */
function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch;
  const base = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    base[key] = mergePatch(base[key], value);
  }
  return base;
}

/** KVOX_SETTINGS over a JSON file. */
export class FileSettings implements KvoxSettingsPort {
  private readonly namespaces = new Map<string, KvoxSettingsNamespaceDef>();

  /** @param path - the JSON file; created on the first write. */
  constructor(private readonly path: string) {}

  private load(): Document {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<Document>;
      return { system: parsed.system ?? {}, user: parsed.user ?? {} };
    } catch {
      return { system: {}, user: {} };
    }
  }

  private save(document: Document): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`);
    renameSync(temp, this.path);
  }

  private declared(scope: 'system' | 'user', name: string): KvoxSettingsNamespaceDef {
    const def = this.namespaces.get(`${scope}:${name}`);
    if (!def) throw new Error(`Unknown ${scope} settings namespace "${name}"`);
    return def;
  }

  registerNamespace(def: KvoxSettingsNamespaceDef): void {
    this.namespaces.set(`${def.scope}:${def.name}`, def);
  }

  async readSystem<T>(name: string, _options?: KvoxReadSystemOptions): Promise<KvoxVersionedSettings<T>> {
    const def = this.declared('system', name);
    const entry = this.load().system[name];
    // A host that keeps no record of who changed a row ignores `withUpdatedBy`.
    if (!entry) return { value: def.schema.parse(def.defaults) as T, version: 0 };
    return { value: def.schema.parse(entry.value) as T, version: entry.version, updatedAt: entry.updatedAt, updatedBy: null };
  }

  async patchSystem<T>(
    name: string,
    patch: Partial<T>,
    ctx: { actorUserId: string; ifMatchVersion?: number },
  ): Promise<KvoxVersionedSettings<T>> {
    const def = this.declared('system', name);
    const document = this.load();
    const entry = document.system[name];
    const version = entry?.version ?? 0;
    if (ctx.ifMatchVersion !== undefined && ctx.ifMatchVersion !== version) {
      throw new Error(`Settings "${name}" are at version ${version}, not ${ctx.ifMatchVersion}`);
    }
    const next = def.schema.parse(mergePatch(entry?.value ?? def.defaults, patch)) as T;
    const stored: SystemEntry = { value: next, version: version + 1, updatedAt: new Date().toISOString() };
    document.system[name] = stored;
    this.save(document);
    return { value: next, version: stored.version, updatedAt: stored.updatedAt, updatedBy: null };
  }

  async readUser<T>(userId: string, name: string): Promise<T> {
    const def = this.declared('user', name);
    return def.schema.parse(this.load().user[`${userId}:${name}`] ?? def.defaults) as T;
  }

  async patchUser<T>(userId: string, name: string, patch: Partial<T>): Promise<T> {
    const def = this.declared('user', name);
    const document = this.load();
    const key = `${userId}:${name}`;
    const next = def.schema.parse(mergePatch(document.user[key] ?? def.defaults, patch)) as T;
    document.user[key] = next;
    this.save(document);
    return next;
  }
}
