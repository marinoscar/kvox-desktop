import type { PrismaClient } from '@prisma/client';

import { seedNoteTemplates } from '@marinoscar/kvox-api/notes/templates';

// =============================================================================
// What the host writes before the first request (from examples/bare-host/src/seed.ts)
// =============================================================================
//
// The domain references `users` and `organizations` by foreign key, so the one
// local user needs a `users` row and an organization. The platform migrations
// already create the default organization (exactly one `is_default` row); the
// host adopts it rather than inserting a second. The user id is fixed so every
// launch finds the same row. Idempotent.
//
// Transcription is NOT turned on: Desktop has no transcription (ADR-0006), so
// no provider is registered and `/api/transcription/config` reports
// `available: false`.
// =============================================================================

/** The one local user. */
export const LOCAL_USER_ID = '00000000-0000-4000-8000-000000000001';

/** Inserts the user and the built-in note templates; answers the default organization's id. */
export async function seedDatabase(prisma: PrismaClient): Promise<string> {
  const existing = await prisma.organization.findFirst({ where: { isDefault: true }, select: { id: true } });
  const orgId =
    existing?.id ??
    (await prisma.organization.create({ data: { name: 'KVox', slug: 'kvox', isDefault: true }, select: { id: true } })).id;
  await prisma.user.upsert({
    where: { id: LOCAL_USER_ID },
    update: {},
    create: { id: LOCAL_USER_ID, email: 'local@kvox-desktop.invalid', displayName: 'Local user' },
  });
  await seedNoteTemplates(prisma);
  return orgId;
}
