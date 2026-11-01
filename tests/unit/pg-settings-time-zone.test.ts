import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import { PgSettings } from '../../src/server/ports/pg-settings';

// KVOX_SETTINGS.readUserTimeZone: Desktop answers the device zone (kvox-ports.md).
describe('PgSettings.readUserTimeZone', () => {
  const settings = new PgSettings({} as PrismaClient);

  afterEach(() => vi.restoreAllMocks());

  it('answers the device zone, for any user', async () => {
    const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
    await expect(settings.readUserTimeZone('user-a')).resolves.toBe(device || null);
  });

  it('answers the zone the runtime reports', async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      timeZone: 'America/Chicago',
    } as Intl.ResolvedDateTimeFormatOptions);
    await expect(settings.readUserTimeZone('user-a')).resolves.toBe('America/Chicago');
  });

  it('answers null when the runtime reports no zone or throws', async () => {
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions');
    spy.mockReturnValue({ timeZone: '' } as Intl.ResolvedDateTimeFormatOptions);
    await expect(settings.readUserTimeZone('user-a')).resolves.toBeNull();
    spy.mockImplementation(() => {
      throw new Error('no Intl');
    });
    await expect(settings.readUserTimeZone('user-a')).resolves.toBeNull();
  });
});
