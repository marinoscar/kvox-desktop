import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { LaunchTokenIdentity } from '../../src/server/ports/launch-token-identity';

const TOKEN = 'a'.repeat(43);

function contextWith(headers: Record<string, string | string[] | undefined>): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => ({ headers }) }) } as unknown as ExecutionContext;
}

const identity = new LaunchTokenIdentity({
  userId: 'user-1',
  orgId: 'org-1',
  permissions: ['notes:read', 'notes:write'],
  token: TOKEN,
});

describe('LaunchTokenIdentity', () => {
  it('answers the local user for the per-launch bearer token', async () => {
    const principal = await identity.authenticate(contextWith({ authorization: `Bearer ${TOKEN}` }));
    expect(principal?.userId).toBe('user-1');
    expect(principal?.orgId).toBe('org-1');
    expect(principal?.permissions.has('notes:write')).toBe(true);
  });

  it.each([
    ['no header', {}],
    ['another token', { authorization: `Bearer ${'b'.repeat(43)}` }],
    ['the token without the scheme', { authorization: TOKEN }],
    ['a prefix of the token', { authorization: `Bearer ${TOKEN.slice(0, 10)}` }],
    ['a repeated header', { authorization: [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`] }],
  ])('answers null for %s', async (_label, headers) => {
    expect(await identity.authenticate(contextWith(headers))).toBeNull();
  });

  it('checks permissions for the local user only', async () => {
    expect(await identity.hasPermission('user-1', 'notes:read')).toBe(true);
    expect(await identity.hasPermission('user-1', 'graph:read')).toBe(false);
    expect(await identity.hasPermission('user-2', 'notes:read')).toBe(false);
  });

  it('refuses a short token', () => {
    expect(() => new LaunchTokenIdentity({ userId: 'u', orgId: 'o', permissions: [], token: 'short' })).toThrow();
  });
});
