import { BadRequestException, Body, ConflictException, Controller, Get, Headers, Inject, Patch } from '@nestjs/common';
import { ZodError } from 'zod';

import { CurrentKvoxPrincipal, KvoxAuth } from '@marinoscar/kvox-api/core';
import { assertGraphPreferenceLimits, graphPreferencesPatchSchema, mergeGraphPreferences } from '@marinoscar/kvox-api/graph';
import { KVOX_SETTINGS, type KvoxPrincipal } from '@marinoscar/kvox-api/ports';

import { PgSettings, mergePatch } from './ports/pg-settings.js';

// =============================================================================
// /api/user-settings: the local user's settings document
// =============================================================================
//
// kvox-web reads and writes the per-user `graph` namespace through this route
// on every host (`useGraphPreferences`, `useGraphSelf`, the explorer's saved
// lenses), with `If-Match` carrying the document's version; on the web it is
// the platform's route. Desktop has no platform API, so this is the same
// contract over KVOX_SETTINGS (`PgSettings`, `user_settings`), on the device:
//
//   GET    the stored document, sparse (a namespace nobody wrote is absent),
//          plus `version` (0 before the first write).
//   PATCH  `{ <namespace>: <patch> }`, declared user namespaces only. `graph`
//          is merged by the package's own `mergeGraphPreferences` (null resets
//          a field or sub-object to its default) and checked by
//          `assertGraphPreferenceLimits`; any other namespace by JSON Merge
//          Patch. A stale `If-Match` is a 409, which the hooks retry once.
//
// Host glue only: the schema, the merge and the limits are kvox-api's. Not
// done here: the web edition's `graph.preferences_changed` forwarding (a
// changed resolution threshold re-queues `kg.resolve` there); Desktop does not
// emit it.
// =============================================================================

/** The document `GET` and `PATCH` answer. */
export type UserSettingsDocument = Record<string, unknown> & { version: number };

/** The `If-Match` version, or `undefined` when absent. */
function ifMatchVersion(header: string | undefined): number | undefined {
  if (header === undefined || header.trim() === '') return undefined;
  const version = Number(header.trim().replace(/^W\//, '').replace(/^"|"$/g, ''));
  if (!Number.isInteger(version) || version < 0) throw new BadRequestException('If-Match must be the settings version');
  return version;
}

@Controller('user-settings')
export class UserSettingsController {
  constructor(@Inject(KVOX_SETTINGS) private readonly settings: PgSettings) {
    if (!(settings instanceof PgSettings)) throw new Error('/api/user-settings needs the PgSettings binding of KVOX_SETTINGS');
  }

  @Get()
  @KvoxAuth()
  async read(@CurrentKvoxPrincipal() principal: KvoxPrincipal): Promise<UserSettingsDocument> {
    const { value, version } = await this.settings.readUserDocument(principal.userId);
    return { ...value, version };
  }

  @Patch()
  @KvoxAuth()
  async patch(
    @CurrentKvoxPrincipal() principal: KvoxPrincipal,
    @Body() body: unknown,
    @Headers('if-match') ifMatch?: string,
  ): Promise<UserSettingsDocument> {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new BadRequestException('Expected an object of user settings namespaces');
    }
    const patch = body as Record<string, unknown>;
    for (const name of Object.keys(patch)) {
      if (!this.settings.hasUserNamespace(name)) throw new BadRequestException(`Unknown user settings namespace "${name}"`);
    }
    const expected = ifMatchVersion(ifMatch);
    const current = await this.settings.readUserDocument(principal.userId);
    if (expected !== undefined && expected !== current.version) {
      throw new ConflictException(`User settings are at version ${current.version}, not ${expected}`);
    }
    try {
      const values: Record<string, unknown> = {};
      for (const [name, namespacePatch] of Object.entries(patch)) {
        if (name === 'graph') {
          const merged = mergeGraphPreferences(
            current.value.graph as Parameters<typeof mergeGraphPreferences>[0],
            namespacePatch === null ? null : graphPreferencesPatchSchema.parse(namespacePatch),
          );
          assertGraphPreferenceLimits(merged);
          values.graph = merged;
        } else {
          values[name] = namespacePatch === null ? undefined : mergePatch(current.value[name], namespacePatch);
        }
      }
      const saved = await this.settings.writeUserNamespaces(principal.userId, values, current.version);
      return { ...saved.value, version: saved.version };
    } catch (error) {
      if (error instanceof ZodError) throw new BadRequestException(error.issues.map((issue) => issue.message).join('; '));
      throw error;
    }
  }
}
