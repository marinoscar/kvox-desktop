import { createHash, timingSafeEqual } from 'node:crypto';

import type { ExecutionContext } from '@nestjs/common';

import type { KvoxIdentityPort, KvoxPrincipal } from '@marinoscar/kvox-api/ports';

// =============================================================================
// LaunchTokenIdentity: KVOX_IDENTITY for the one local user of KVox Desktop
// =============================================================================
//
// The bare host's LocalSingleUserIdentity (examples/bare-host/src/ports/
// local-single-user-identity.ts) with the header swapped for the guide's
// Desktop recommendation: the main process mints a random token per launch and
// hands it only to its own window; every call, `http` and `sse` alike, carries
// `Authorization: Bearer <token>`. The comparison is constant time (both sides
// are hashed first, so the lengths match). Anything else is `null`, so the 401
// path of every guarded route stays real.
// =============================================================================

/** Options of {@link LaunchTokenIdentity}. */
export interface LaunchTokenIdentityOptions {
  /** The seeded `users.id`. */
  userId: string;
  /** The adopted default `organizations.id`. */
  orgId: string;
  /** Every permission string the user holds. */
  permissions: readonly string[];
  /** The per-launch token. */
  token: string;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** KVOX_IDENTITY: one local user, recognised by the per-launch bearer token. */
export class LaunchTokenIdentity implements KvoxIdentityPort {
  private readonly principal: KvoxPrincipal;
  private readonly expected: Buffer;

  constructor(options: LaunchTokenIdentityOptions) {
    if (options.token.length < 32) throw new Error('The launch token is too short');
    this.expected = digest(`Bearer ${options.token}`);
    this.principal = {
      userId: options.userId,
      orgId: options.orgId,
      roles: ['local'],
      permissions: new Set(options.permissions),
    };
  }

  async authenticate(context: ExecutionContext): Promise<KvoxPrincipal | null> {
    const request = context.switchToHttp().getRequest<{ headers?: Record<string, string | string[] | undefined> }>();
    const header = request?.headers?.authorization;
    if (typeof header !== 'string') return null;
    return timingSafeEqual(digest(header), this.expected) ? this.principal : null;
  }

  async hasPermission(userId: string, permission: string): Promise<boolean> {
    return userId === this.principal.userId && this.principal.permissions.has(permission);
  }
}
