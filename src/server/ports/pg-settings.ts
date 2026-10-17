import { ConflictException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';

import type {
  KvoxReadSystemOptions,
  KvoxSettingsNamespaceDef,
  KvoxSettingsPort,
  KvoxVersionedSettings,
} from '@marinoscar/kvox-api/ports';

// =============================================================================
// PgSettings: KVOX_SETTINGS over the platform settings tables (marinoscar/kvox#583)
// =============================================================================
//
// The platform migrations already create `system_settings` and `user_settings`,
// so the settings live in the database with everything else (and travel in a
// backup with it). The bare host's JSON-file binding (`file-settings.ts` there)
// is the behaviour this keeps:
//
//   system   one `system_settings` row per namespace, `key` = the namespace
//            name, its own `version` for `ifMatchVersion`. No row reads as the
//            defaults at version 0; the first write creates version 1.
//   user     one `user_settings` row per user, `value` = `{ <namespace>: value }`
//            (the web edition's shape), `version` bumped on every write.
//
//   - A patch is a JSON Merge Patch over the stored value (or the defaults), and
//     the result must pass the namespace's schema before anything is written.
//   - A namespace declared with `defaults: undefined` reads as `undefined` while
//     nothing is stored; only a stored value is schema-parsed (kvox-ports.md 3.8,
//     marinoscar/kvox#593).
//   - A concurrent writer is caught by the version in the UPDATE's WHERE clause,
//     not by a transaction (PGlite is one session; see `pg-table-jobs.ts`).
//
// The shell's own preferences (window, plaintext-secrets consent) are not here:
// the main process keeps them in `<userData>/settings.json`.
// =============================================================================

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

/** A stored value parsed, or the defaults: parsed when declared, `undefined` when not. */
function parsedOrDefaults(def: KvoxSettingsNamespaceDef, stored: unknown): unknown {
  if (stored !== undefined) return def.schema.parse(stored);
  return def.defaults === undefined ? undefined : def.schema.parse(def.defaults);
}

/** KVOX_SETTINGS over `system_settings` and `user_settings`. */
export class PgSettings implements KvoxSettingsPort {
  private readonly namespaces = new Map<string, KvoxSettingsNamespaceDef>();

  constructor(private readonly prisma: PrismaClient) {}

  private declared(scope: 'system' | 'user', name: string): KvoxSettingsNamespaceDef {
    const def = this.namespaces.get(`${scope}:${name}`);
    if (!def) throw new Error(`Unknown ${scope} settings namespace "${name}"`);
    return def;
  }

  registerNamespace(def: KvoxSettingsNamespaceDef): void {
    this.namespaces.set(`${def.scope}:${def.name}`, def);
  }

  async readSystem<T>(name: string, options?: KvoxReadSystemOptions): Promise<KvoxVersionedSettings<T>> {
    const def = this.declared('system', name);
    const row = await this.prisma.systemSettings.findUnique({
      where: { key: name },
      include: options?.withUpdatedBy ? { updatedByUser: { select: { id: true, email: true } } } : undefined,
    });
    if (!row) return { value: parsedOrDefaults(def, undefined) as T, version: 0 };
    const versioned: KvoxVersionedSettings<T> = { value: parsedOrDefaults(def, row.value) as T, version: row.version };
    if (!options?.withUpdatedBy) return versioned;
    const updatedBy = (row as typeof row & { updatedByUser?: { id: string; email: string } | null }).updatedByUser ?? null;
    return { ...versioned, updatedAt: row.updatedAt.toISOString(), updatedBy };
  }

  async patchSystem<T>(
    name: string,
    patch: Partial<T>,
    ctx: { actorUserId: string; ifMatchVersion?: number },
  ): Promise<KvoxVersionedSettings<T>> {
    const def = this.declared('system', name);
    const row = await this.prisma.systemSettings.findUnique({ where: { key: name } });
    const version = row?.version ?? 0;
    if (ctx.ifMatchVersion !== undefined && ctx.ifMatchVersion !== version) {
      throw new ConflictException(`Settings "${name}" are at version ${version}, not ${ctx.ifMatchVersion}`);
    }
    const next = def.schema.parse(mergePatch(row ? row.value : def.defaults, patch)) as T;
    const value = next as Prisma.InputJsonValue;
    if (row) {
      const updated = await this.prisma.systemSettings.updateMany({
        where: { key: name, version },
        data: { value, version: version + 1, updatedByUserId: ctx.actorUserId },
      });
      if (updated.count === 0) throw new ConflictException(`Settings "${name}" changed while they were being saved`);
    } else {
      try {
        await this.prisma.systemSettings.create({ data: { key: name, value, version: 1, updatedByUserId: ctx.actorUserId } });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new ConflictException(`Settings "${name}" changed while they were being saved`);
        }
        throw error;
      }
    }
    return { value: next, version: version + 1 };
  }

  async readUser<T>(userId: string, name: string): Promise<T> {
    const def = this.declared('user', name);
    const row = await this.prisma.userSettings.findUnique({ where: { userId } });
    const stored = isPlainObject(row?.value) ? row.value[name] : undefined;
    return parsedOrDefaults(def, stored) as T;
  }

  async patchUser<T>(userId: string, name: string, patch: Partial<T>): Promise<T> {
    const def = this.declared('user', name);
    // Two tries: a concurrent writer of another namespace of the same user moves the version.
    for (let attempt = 0; ; attempt += 1) {
      const row = await this.prisma.userSettings.findUnique({ where: { userId } });
      const all = isPlainObject(row?.value) ? row.value : {};
      const next = def.schema.parse(mergePatch(all[name] ?? def.defaults, patch)) as T;
      const value = { ...all, [name]: next } as Prisma.InputJsonValue;
      if (row) {
        const updated = await this.prisma.userSettings.updateMany({
          where: { userId, version: row.version },
          data: { value, version: row.version + 1 },
        });
        if (updated.count > 0) return next;
      } else {
        try {
          await this.prisma.userSettings.create({ data: { userId, value, version: 1 } });
          return next;
        } catch (error) {
          if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
        }
      }
      if (attempt >= 1) throw new ConflictException(`Settings "${name}" changed while they were being saved`);
    }
  }
}
