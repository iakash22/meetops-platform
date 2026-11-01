import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { Value } from '@sinclair/typebox/value';
import { ApiErrorEnvelope } from '@meetops/contracts';
import { buildApp, type App } from './helpers.js';
import { ErrorBody } from '../src/modules/auth/http/schemas.js';
import { DomainError } from '../src/shared/domain-error.js';
import { registerDomainErrorHandler } from '../src/shared/http-errors.js';
import { LastOwnerError } from '../src/modules/organizations/domain/errors.js';

const apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

/** Tiny app with the real error handler and the real ErrorBody response schema. */
async function errorApp(err: Error) {
  const app = Fastify();
  registerDomainErrorHandler(app);
  app.get('/boom', { schema: { response: { 409: ErrorBody, 400: ErrorBody } } }, async () => {
    throw err;
  });
  apps.push(app);
  await app.ready();
  return app;
}

describe('contracts v0.3.3 error envelope', () => {
  it('ErrorBody is the contracts ApiErrorEnvelope (so `reason` is serialized, not stripped)', () => {
    expect(ErrorBody).toBe(ApiErrorEnvelope);
  });

  it('LastOwnerError is 409 CONFLICT with reason LAST_OWNER', async () => {
    const res = await (
      await errorApp(new LastOwnerError())
    ).inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'CONFLICT', reason: 'LAST_OWNER' });
    expect(Value.Check(ApiErrorEnvelope, res.json())).toBe(true);
  });

  it('a 409 without a specific reason gets the generic CONFLICT reason', async () => {
    const res = await (
      await errorApp(new DomainError('CONFLICT', 'Conflict', 409))
    ).inject({ method: 'GET', url: '/boom' });
    expect(res.json().error.reason).toBe('CONFLICT');
  });

  it('non-409 errors carry no reason', async () => {
    const res = await (
      await errorApp(new DomainError('BAD_REQUEST', 'Bad', 400))
    ).inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).not.toHaveProperty('reason');
  });
});

describe('organizations OpenAPI', () => {
  let app: App;
  afterEach(async () => {
    await app.close();
  });

  it('uses :organizationId params, no 410 on revoke, 409 (not 422) for member changes', async () => {
    app = await buildApp();
    const spec = app.swagger() as unknown as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    const orgPaths = Object.keys(spec.paths).filter((p) => p.startsWith('/orgs/'));
    expect(
      orgPaths.filter((p) => p.startsWith('/orgs/{organizationId}')).length,
    ).toBeGreaterThanOrEqual(4);
    for (const p of orgPaths) {
      expect(p).not.toMatch(/\{id\}/);
    }
    const revoke = spec.paths['/orgs/{organizationId}/invitations/{invitationId}/revoke']!.post!;
    expect(revoke.responses).not.toHaveProperty('410');
    const member = spec.paths['/orgs/{organizationId}/members/{userId}']!;
    for (const m of [member.patch!, member.delete!]) {
      expect(m.responses).toHaveProperty('409');
      expect(m.responses).not.toHaveProperty('422');
    }
  });
});
