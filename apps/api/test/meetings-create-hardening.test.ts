/**
 * #446 Tester & Security follow-ups for POST /orgs/:org/meetings (and the shared limiter guard on resolve):
 * soft-deleted project, per-org 429, limiter failure/timeout -> 503 + Retry-After, status/createdById rejected,
 * admin can create, viewer 403 writes no audit entry.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InMemoryAuditLog } from '../src/modules/auth/domain/audit.js';
import { InMemoryRateLimiter } from '../src/modules/auth/infrastructure/rate-limit/in-memory.js';
import type { RateLimiter, RateLimitResult } from '../src/modules/auth/domain/ports.js';
import { defaultModuleDeps } from '../src/modules/index.js';
import { InMemoryMeetingRepository } from '../src/modules/meetings/infrastructure/in-memory.repository.js';
import { consumeGuarded, RATE_LIMITER_TIMEOUT_MS } from '../src/shared/guarded-limit.js';
import { RateLimiterUnavailableError } from '../src/modules/media/http/rate-limit.js';
import { RateLimitedError } from '../src/modules/auth/domain/errors.js';
import { buildApp, signupAndLogin, type App, type Client } from './helpers.js';

type Mode = 'pass' | 'fail' | 'hang' | 'deny-org';

/** Delegates to a real in-memory limiter; only `meetings:*` keys are affected by the mode (auth keeps working). */
class SwitchableLimiter implements RateLimiter {
  mode: Mode = 'pass';
  readonly keys: string[] = [];
  private readonly inner = new InMemoryRateLimiter({ now: () => new Date() });
  consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    if (key.startsWith('meetings:')) {
      this.keys.push(key);
      if (this.mode === 'fail') return Promise.reject(new Error('ECONNREFUSED'));
      if (this.mode === 'hang') return new Promise(() => undefined);
      if (this.mode === 'deny-org' && key.includes(':org:'))
        return Promise.resolve({ allowed: false, retryAfterMs: 42_000 });
    }
    return this.inner.consume(key, limit, windowMs);
  }
}

describe('POST /orgs/:org/meetings hardening (#446)', () => {
  let app: App;
  let audit: InMemoryAuditLog;
  let meetings: InMemoryMeetingRepository;
  let limiter: SwitchableLimiter;
  beforeEach(async () => {
    audit = new InMemoryAuditLog();
    meetings = new InMemoryMeetingRepository();
    limiter = new SwitchableLimiter();
    app = await buildApp(defaultModuleDeps({ audit, meetings, rateLimiter: limiter }));
  });
  afterEach(async () => app.close());

  async function join(
    owner: Client,
    orgId: string,
    email: string,
    role: 'admin' | 'member' | 'viewer',
  ) {
    const c = await signupAndLogin(app, email);
    expect((await owner.post(`/orgs/${orgId}/invitations`, { email, role })).statusCode).toBe(201);
    const sent = [...app.mail.sent].reverse().find((m) => m.template === 'invitation');
    const token = new URL(sent!.data.url!).searchParams.get('token')!;
    expect((await c.post('/invitations/accept', { token })).statusCode).toBe(200);
    expect((await c.post('/orgs/switch', { organizationId: orgId })).statusCode).toBe(200);
    return c;
  }
  async function world() {
    const owner = await signupAndLogin(app, 'owner@example.com');
    const org = (await owner.post('/orgs', { name: 'Acme' })).json<{
      organization: { id: string };
    }>().organization.id;
    return { owner, org };
  }
  const creates = () => audit.events.filter((e) => e.action === 'meeting.create');

  it('rejects a soft-deleted project with 400 and links nothing (in-memory repo always validates)', async () => {
    const { owner, org } = await world();
    const PROJ = '00000000-0000-4000-8000-0000000005a1';
    // Unset/empty project store: any projectId is rejected (no longer skipped).
    let r = await owner.post(`/orgs/${org}/meetings`, { title: 'x', projectId: PROJ });
    expect([r.statusCode, r.json().error.code]).toEqual([400, 'VALIDATION_FAILED']);
    meetings.projects.add(`${org}:${PROJ}`);
    expect(
      (await owner.post(`/orgs/${org}/meetings`, { title: 'ok', projectId: PROJ })).statusCode,
    ).toBe(201);
    meetings.projects.delete(`${org}:${PROJ}`); // soft delete
    r = await owner.post(`/orgs/${org}/meetings`, { title: 'late', projectId: PROJ });
    expect([r.statusCode, r.json().error.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect(meetings.rows.size).toBe(1);
    expect(creates()).toHaveLength(1);
  });

  it('charges the per-org bucket: per-org 429 + retry-after, no row, no audit', async () => {
    const { owner, org } = await world();
    limiter.mode = 'deny-org';
    const r = await owner.post(`/orgs/${org}/meetings`, { title: 'x' });
    expect(r.statusCode).toBe(429);
    expect(r.json().error.code).toBe('RATE_LIMITED');
    expect(r.headers['retry-after']).toBe('42');
    expect(limiter.keys).toEqual([
      expect.stringMatching(/^meetings:create:user:/),
      `meetings:create:org:${org}`,
    ]);
    expect(meetings.rows.size).toBe(0);
    expect(creates()).toHaveLength(0);
  });

  for (const route of ['create', 'resolve'] as const) {
    it(`${route}: a limiter error fails closed with 503 + retry-after`, async () => {
      const { owner, org } = await world();
      limiter.mode = 'fail';
      const r =
        route === 'create'
          ? await owner.post(`/orgs/${org}/meetings`, { title: 'x' })
          : await owner.post(`/orgs/${org}/meetings/resolve`, {
              source: 'extension',
              externalMeetingId: 'z-1',
            });
      expect(r.statusCode).toBe(503);
      expect(r.json().error.code).toBe('PROVIDER_UNAVAILABLE');
      expect(r.headers['retry-after']).toBe('5');
      expect(meetings.rows.size).toBe(0);
      expect(creates()).toHaveLength(0);
    });
  }

  it('a limiter that never answers times out after ~1.5 s with 503 + retry-after', async () => {
    const { owner, org } = await world();
    limiter.mode = 'hang';
    const t0 = Date.now();
    const r = await owner.post(`/orgs/${org}/meetings`, { title: 'x' });
    const elapsed = Date.now() - t0;
    expect(r.statusCode).toBe(503);
    expect(r.headers['retry-after']).toBe('5');
    expect(elapsed).toBeGreaterThanOrEqual(RATE_LIMITER_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(RATE_LIMITER_TIMEOUT_MS + 2_000);
    expect(meetings.rows.size).toBe(0);
  }, 10_000);

  it('rejects status and createdById in the body (400 VALIDATION_FAILED)', async () => {
    const { owner, org } = await world();
    for (const body of [
      { title: 'a', status: 'completed' },
      { title: 'a', createdById: '00000000-0000-4000-8000-0000000005b1' },
    ]) {
      const r = await owner.post(`/orgs/${org}/meetings`, body);
      expect([r.statusCode, r.json().error.code], JSON.stringify(body)).toEqual([
        400,
        'VALIDATION_FAILED',
      ]);
    }
    expect(meetings.rows.size).toBe(0);
  });

  it('admin can create (201, audited); viewer gets 403 and writes no audit entry', async () => {
    const { owner, org } = await world();
    const admin = await join(owner, org, 'admin@example.com', 'admin');
    const viewer = await join(owner, org, 'viewer@example.com', 'viewer');
    const a = await admin.post(`/orgs/${org}/meetings`, { title: 'By admin' });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ source: 'upload', status: 'scheduled' });
    expect(creates()).toHaveLength(1);
    const before = audit.events.length;
    const v = await viewer.post(`/orgs/${org}/meetings`, { title: 'By viewer' });
    expect(v.statusCode).toBe(403);
    expect(audit.events.length).toBe(before);
    expect(creates()).toHaveLength(1);
    expect(meetings.rows.size).toBe(1);
  });
});

describe('consumeGuarded (shared limiter guard)', () => {
  const l = { limit: 1, windowMs: 1_000 };
  it('passes, 429s, and maps errors/timeouts to RateLimiterUnavailableError', async () => {
    const ok: RateLimiter = { consume: () => Promise.resolve({ allowed: true, retryAfterMs: 0 }) };
    await expect(consumeGuarded(ok, 'k', l)).resolves.toBeUndefined();
    const deny: RateLimiter = {
      consume: () => Promise.resolve({ allowed: false, retryAfterMs: 7 }),
    };
    await expect(consumeGuarded(deny, 'k', l)).rejects.toBeInstanceOf(RateLimitedError);
    const boom: RateLimiter = { consume: () => Promise.reject(new Error('x')) };
    await expect(consumeGuarded(boom, 'k', l)).rejects.toBeInstanceOf(RateLimiterUnavailableError);
    const hang: RateLimiter = { consume: () => new Promise(() => undefined) };
    const e = await consumeGuarded(hang, 'k', l, 20).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RateLimiterUnavailableError);
    expect((e as RateLimiterUnavailableError).retryAfterMs).toBe(5_000);
    expect((e as RateLimiterUnavailableError).statusCode).toBe(503);
  });
});
