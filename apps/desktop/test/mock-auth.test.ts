import { describe, expect, it } from 'vitest';

import { AuthError } from '@/features/auth/auth-client';
import { createMockAuthClient, MOCK_REJECT_DOMAIN } from '@/features/auth/mock-auth';

const client = createMockAuthClient({ delayMs: 0 });

describe('mock auth client', () => {
  it('returns a contracts-shaped session for valid credentials', async () => {
    const session = await client.signIn({ email: ' Alex@Example.com ', password: 'pw' });
    expect(session.user.email).toBe('alex@example.com');
    expect(session.activeOrganizationId).toBe(session.organizations[0]?.id);
    expect(session.role).toBe('member');
  });

  it('never produces token material', async () => {
    const session = await client.signIn({ email: 'alex@example.com', password: 'pw' });
    const json = JSON.stringify(session).toLowerCase();
    for (const key of ['token', 'csrf', 'secret', 'password', 'cookie']) {
      expect(json).not.toContain(key);
    }
  });

  it('rejects malformed input with VALIDATION_FAILED', async () => {
    await expect(client.signIn({ email: 'not-an-email', password: 'pw' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(client.signIn({ email: 'a@b.co', password: '' })).rejects.toBeInstanceOf(
      AuthError,
    );
  });

  it(`rejects ${MOCK_REJECT_DOMAIN} with AUTH_FAILED`, async () => {
    await expect(
      client.signIn({ email: `x${MOCK_REJECT_DOMAIN}`, password: 'pw' }),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });
});
