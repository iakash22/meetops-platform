import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { UnauthenticatedError } from '../src/modules/auth/domain/errors.js';
import { bearerAwareMutationGuard } from '../src/modules/extension-auth/http/dual-caller.js';

const ORG = '00000000-0000-4000-8000-000000000001';
const req = (url: string, headers: Record<string, string>, cookies: Record<string, string> = {}) =>
  ({ url, headers, cookies }) as unknown as FastifyRequest;
const BEARER = { authorization: 'Bearer junk' };

describe('security review B 2.1: CSRF is skipped only for bearer-enabled routes', () => {
  const setup = (bearerEnabled: boolean) => {
    const csrf = vi.fn().mockResolvedValue(undefined);
    return {
      csrf,
      guard: bearerAwareMutationGuard(csrf, { cookieName: 'meetops_sid', bearerEnabled }),
    };
  };

  it('skips CSRF for a bearer on an extension bearer route when a guard is wired', async () => {
    const { csrf, guard } = setup(true);
    await guard(req(`/orgs/${ORG}/meetings/resolve`, BEARER));
    await guard(req(`/orgs/${ORG}/recording-sessions?x=1`, BEARER));
    expect(csrf).not.toHaveBeenCalled();
  });

  it('runs CSRF for a bearer on a cookie-only route', async () => {
    const { csrf, guard } = setup(true);
    await guard(req(`/orgs/${ORG}/uploads/${ORG}/download-url`, BEARER));
    await guard(req(`/orgs/${ORG}/meetings`, BEARER));
    expect(csrf).toHaveBeenCalledTimes(2);
  });

  it('runs CSRF for a bearer on bearer routes when no bearer guard is wired', async () => {
    const { csrf, guard } = setup(false);
    await guard(req(`/orgs/${ORG}/meetings/resolve`, BEARER));
    expect(csrf).toHaveBeenCalledTimes(1);
  });

  it('rejects a session cookie together with a bearer (401) before CSRF', async () => {
    for (const enabled of [true, false]) {
      const { csrf, guard } = setup(enabled);
      await expect(
        guard(req(`/orgs/${ORG}/meetings/resolve`, BEARER, { meetops_sid: 's' })),
      ).rejects.toBeInstanceOf(UnauthenticatedError);
      expect(csrf).not.toHaveBeenCalled();
    }
  });

  it('cookie-only requests keep the normal guard', async () => {
    const { csrf, guard } = setup(true);
    await guard(req(`/orgs/${ORG}/meetings/resolve`, {}, { meetops_sid: 's' }));
    expect(csrf).toHaveBeenCalledTimes(1);
  });
});
