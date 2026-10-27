import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { Integration, IntegrationList, type Role } from '@meetops/contracts';
import { InMemoryAuditLog } from '../src/modules/auth/domain/audit.js';
import { InMemoryIntegrations } from '../src/modules/integrations/in-memory.repository.js';
import { selectIntegrationsRepository } from '../src/modules/integrations/index.js';
import { MissingProductionDependencyError, type ModuleDeps } from '../src/modules/index.js';
import { buildApp, signupAndLogin, type App, type Client } from './helpers.js';

const INT = '00000000-0000-4000-8000-0000000001a1';
const USER = '00000000-0000-4000-8000-0000000001b1';

describe('Phase 5 integrations list and disconnect', () => {
  let app: App;
  let repo: InMemoryIntegrations;
  let audit: InMemoryAuditLog;
  beforeEach(async () => {
    repo = new InMemoryIntegrations();
    audit = new InMemoryAuditLog();
    app = await buildApp({ integrations: repo, audit } as Partial<ModuleDeps>);
  });
  afterEach(async () => app.close());

  const createOrg = async (c: Client, name: string) =>
    (await c.post('/orgs', { name })).json<{ organization: { id: string } }>().organization.id;
  async function join(owner: Client, orgId: string, email: string, role: Role) {
    const c = await signupAndLogin(app, email);
    expect((await owner.post(`/orgs/${orgId}/invitations`, { email, role })).statusCode).toBe(201);
    const sent = [...app.mail.sent].reverse().find((m) => m.template === 'invitation');
    const token = new URL(sent!.data.url!).searchParams.get('token')!;
    expect((await c.post('/invitations/accept', { token })).statusCode).toBe(200);
    expect((await c.post('/orgs/switch', { organizationId: orgId })).statusCode).toBe(200);
    return c;
  }
  const seed = (organizationId: string, id = INT) =>
    repo.add({
      id,
      organizationId,
      provider: 'github',
      status: 'active',
      displayName: 'acme',
      externalAccountId: '42',
      connectedById: USER,
      createdAt: '2026-10-27T00:00:00.000Z',
      updatedAt: '2026-10-27T00:00:00.000Z',
    });

  it('lists contract DTOs to members and lets owners disconnect idempotently', async () => {
    const owner = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(owner, 'Acme');
    seed(org);
    const member = await join(owner, org, 'm@example.com', 'member');
    const list = await member.get(`/orgs/${org}/integrations`);
    expect(list.statusCode).toBe(200);
    expect(Value.Check(IntegrationList, list.json())).toBe(true);
    expect(list.json().items).toHaveLength(1);
    expect(list.body).not.toMatch(/token|secret|keyId/i);

    expect((await member.delete(`/orgs/${org}/integrations/${INT}`)).statusCode).toBe(403);
    const del = await owner.delete(`/orgs/${org}/integrations/${INT}`);
    expect(del.statusCode).toBe(200);
    expect(Value.Check(Integration, del.json())).toBe(true);
    expect(del.json().status).toBe('revoked');
    expect(repo.secrets.get(INT)).toBe(false);
    expect(
      audit.events.some((e) => e.action === 'integration.disconnect' && e.targetId === INT),
    ).toBe(true);
    expect((await owner.delete(`/orgs/${org}/integrations/${INT}`)).statusCode).toBe(200);
  });

  it('admins may disconnect', async () => {
    const owner = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(owner, 'Acme');
    seed(org);
    const admin = await join(owner, org, 'a@example.com', 'admin');
    expect((await admin.delete(`/orgs/${org}/integrations/${INT}`)).statusCode).toBe(200);
  });

  it('hides other orgs and rejects unauthenticated or malformed requests', async () => {
    const a = await signupAndLogin(app, 'a@example.com');
    const orgA = await createOrg(a, 'A');
    const b = await signupAndLogin(app, 'b@example.com');
    const orgB = await createOrg(b, 'B');
    seed(orgB);
    expect((await a.delete(`/orgs/${orgA}/integrations/${INT}`)).statusCode).toBe(404);
    expect((await a.get(`/orgs/${orgB}/integrations`)).statusCode).not.toBe(200);
    expect((await a.get(`/orgs/${orgA}/integrations`)).json().items).toEqual([]);
    expect((await a.delete(`/orgs/${orgA}/integrations/not-a-uuid`)).statusCode).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: `/orgs/${orgA}/integrations` })).statusCode,
    ).toBe(401);
  });

  it('refuses the in-memory repository outside development/test', () => {
    expect(() => selectIntegrationsRepository({} as ModuleDeps, 'production')).toThrow(
      MissingProductionDependencyError,
    );
  });
});
