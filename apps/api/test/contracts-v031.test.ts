import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { Type } from '@sinclair/typebox';
import {
  Id,
  ListMembersResponse,
  ListOrganizationsResponse,
  ListSessionsResponse,
  OrganizationWithRole,
} from '@meetops/contracts';
import { buildApp, signupAndLogin, Client, PASSWORD, type App } from './helpers.js';
import { createServer, AJV_CUSTOM_OPTIONS } from '../src/server.js';
import {
  CreateOrganizationBody,
  MemberList,
  OrganizationList,
} from '../src/modules/organizations/http/schemas.js';
import { SessionList } from '../src/modules/auth/http/schemas.js';
import { capIp, capUserAgent } from '../src/modules/auth/http/security.js';

describe('contracts v0.3.1 alignment', () => {
  let app: App;
  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => app.close());

  const tokenFor = (email: string) => app.token(email, 'invitation')!;

  /** owner + admin + member + viewer in one org. */
  const setup = async () => {
    const owner = await signupAndLogin(app, 'owner@example.com');
    const id = (await owner.post('/orgs', { name: 'Acme' })).json().organization.id as string;
    const join = async (email: string, role: 'admin' | 'member' | 'viewer') => {
      expect((await owner.post(`/orgs/${id}/invitations`, { email, role })).statusCode).toBe(201);
      const c = await signupAndLogin(app, email);
      expect((await c.post('/invitations/accept', { token: tokenFor(email) })).statusCode).toBe(
        200,
      );
      return c;
    };
    return {
      owner,
      id,
      admin: await join('admin@example.com', 'admin'),
      member: await join('member@example.com', 'member'),
      viewer: await join('viewer@example.com', 'viewer'),
    };
  };

  it('(a) uses the @meetops/contracts schemas for create/list orgs and members', () => {
    expect(OrganizationList).toBe(ListOrganizationsResponse);
    expect(MemberList).toBe(ListMembersResponse);
    expect(SessionList).toBe(ListSessionsResponse);
    expect(CreateOrganizationBody.additionalProperties).toBe(false);
  });

  it('(a) org responses validate against the strict contract (no extra keys)', async () => {
    const owner = await signupAndLogin(app, 'owner@example.com');
    const created = await owner.post('/orgs', { name: 'Acme' });
    expect(created.statusCode).toBe(201);
    expect(Value.Check(OrganizationWithRole, created.json())).toBe(true);
    const list = await owner.get('/orgs');
    expect(Value.Check(ListOrganizationsResponse, list.json())).toBe(true);
    expect((await owner.post('/orgs', { name: ' padded ' })).statusCode).toBe(400);
    expect((await owner.post('/orgs', { name: 'Acme', extra: 1 })).statusCode).toBe(400);
  });

  it('(b) session, org and member lists return nextCursor and page with it', async () => {
    const c = await signupAndLogin(app, 'pager@example.com');
    for (let i = 0; i < 2; i++)
      expect(
        (
          await new Client(app).post('/auth/login', {
            email: 'pager@example.com',
            password: PASSWORD,
          })
        ).statusCode,
      ).toBe(200);
    const p1 = await c.get('/auth/sessions?limit=2');
    expect(p1.statusCode).toBe(200);
    expect(Value.Check(ListSessionsResponse, p1.json())).toBe(true);
    expect(p1.json().items).toHaveLength(2);
    expect(typeof p1.json().nextCursor).toBe('string');
    const p2 = (await c.get(`/auth/sessions?limit=2&cursor=${p1.json().nextCursor}`)).json();
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    expect(new Set([...p1.json().items, ...p2.items].map((s: { id: string }) => s.id)).size).toBe(
      3,
    );
    expect((await c.get('/auth/sessions?cursor=bogus')).statusCode).toBe(400);

    const { owner, id } = await setup();
    const m1 = (await owner.get(`/orgs/${id}/members?limit=3`)).json();
    expect(m1.items).toHaveLength(3);
    const m2 = (await owner.get(`/orgs/${id}/members?limit=3&cursor=${m1.nextCursor}`)).json();
    expect(m2.items).toHaveLength(1);
    expect(m2.nextCursor).toBeNull();
    expect((await owner.get('/orgs')).json().nextCursor).toBeNull();
  });

  it('(c) member list carries a user summary; email only for owner/admin viewers, key omitted otherwise', async () => {
    const { owner, admin, member, viewer, id } = await setup();
    for (const c of [owner, admin]) {
      const body = (await c.get(`/orgs/${id}/members`)).json();
      expect(Value.Check(ListMembersResponse, body)).toBe(true);
      for (const m of body.items) {
        expect(m.user.id).toBe(m.userId);
        expect(m.user.email).toMatch(/@example\.com$/);
        expect(m.user.name).toBe('Test User');
      }
    }
    for (const c of [member, viewer]) {
      const res = await c.get(`/orgs/${id}/members`);
      const body = res.json();
      expect(Value.Check(ListMembersResponse, body)).toBe(true);
      for (const m of body.items) {
        expect(m.user.id).toBe(m.userId);
        expect('email' in m.user).toBe(false);
      }
      expect(res.body).not.toContain('@example.com');
    }
  });

  it('(d) caps ip at 45 and truncates userAgent at 1024 (stored and listed)', async () => {
    expect(capIp('a'.repeat(60))).toHaveLength(45);
    expect(capIp(null)).toBeNull();
    expect(capUserAgent('u'.repeat(5000))).toHaveLength(1024);
    expect(capUserAgent('short')).toBe('short');

    const c = await signupAndLogin(app, 'ua@example.com');
    const long = new Client(app);
    const login = await long.post(
      '/auth/login',
      { email: 'ua@example.com', password: PASSWORD },
      { 'user-agent': 'X'.repeat(3000) },
    );
    expect(login.statusCode).toBe(200);
    const sessions = (await c.get('/auth/sessions')).json();
    expect(Value.Check(ListSessionsResponse, sessions)).toBe(true);
    const uas = sessions.items.map((s: { userAgent: string | null }) => s.userAgent);
    expect(uas).toContain('X'.repeat(1024));
    for (const s of sessions.items) if (s.ip) expect(s.ip.length).toBeLessThanOrEqual(45);
  });

  it('(e) keeps Ajv coercion on: unassigned=true (a query string) validates as the tasks contract expects', async () => {
    expect(AJV_CUSTOM_OPTIONS.coerceTypes).toBe('array');
    const server = createServer();
    // Same unassigned/assigneeId union as contracts ListTasksQuery, minus the `limit` default that Ajv strict mode
    // rejects inside anyOf (reported to the contracts owner; the real tasks route does not exist in apps/api yet).
    const TasksQueryShape = Type.Union([
      Type.Object({ assigneeId: Type.Optional(Id) }, { additionalProperties: false }),
      Type.Object(
        { unassigned: Type.Optional(Type.Literal(true)) },
        { additionalProperties: false },
      ),
    ]);
    server.get('/coercion-probe', { schema: { querystring: TasksQueryShape } }, async (req) => ({
      query: req.query,
    }));
    await server.ready();
    try {
      const ok = await server.inject({ method: 'GET', url: '/coercion-probe?unassigned=true' });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().query.unassigned).toBe(true);
      expect(
        (await server.inject({ method: 'GET', url: '/coercion-probe?unassigned=false' }))
          .statusCode,
      ).toBe(400);
      const both = `/coercion-probe?unassigned=true&assigneeId=${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`;
      expect((await server.inject({ method: 'GET', url: both })).statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });
});
