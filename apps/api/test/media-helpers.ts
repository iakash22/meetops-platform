import { expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { ApiErrorEnvelope, CURRENT_CONSENT_VERSION } from '@meetops/contracts';
import {
  defaultModuleDeps,
  inMemoryMediaAdapters,
  type MediaAdapters,
  type ModuleDeps,
} from '../src/modules/index.js';
import type {
  FakeMediaSigner,
  InMemoryConsentRepository,
  InMemoryMediaJobQueue,
} from '../src/modules/media/infrastructure/in-memory.js';
import { buildApp, signupAndLogin, type App, type Client } from './helpers.js';

export const SHA_B64 = 'n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=';
export const consent = (over: Record<string, unknown> = {}) => ({
  consentVersion: CURRENT_CONSENT_VERSION,
  attestedAt: new Date().toISOString(),
  method: 'all_parties_consented',
  ...over,
});

export interface MediaWorld {
  app: App;
  media: MediaAdapters;
  signer: FakeMediaSigner;
  jobs: InMemoryMediaJobQueue;
  consents: InMemoryConsentRepository;
  owner: Client;
  member: Client;
  viewer: Client;
  other: Client;
  org: string;
  otherOrg: string;
}

export async function mediaWorld(extra: Partial<ModuleDeps> = {}): Promise<MediaWorld> {
  const media = inMemoryMediaAdapters();
  const app = await buildApp(defaultModuleDeps({ media, ...extra }));
  const createOrg = async (c: Client, name: string) =>
    (await c.post('/orgs', { name })).json<{ organization: { id: string } }>().organization.id;
  const join = async (owner: Client, orgId: string, email: string, role: string) => {
    const c = await signupAndLogin(app, email);
    expect((await owner.post(`/orgs/${orgId}/invitations`, { email, role })).statusCode).toBe(201);
    const sent = [...app.mail.sent].reverse().find((m) => m.template === 'invitation');
    const token = new URL(sent!.data.url!).searchParams.get('token')!;
    expect((await c.post('/invitations/accept', { token })).statusCode).toBe(200);
    expect((await c.post('/orgs/switch', { organizationId: orgId })).statusCode).toBe(200);
    return c;
  };
  const owner = await signupAndLogin(app, 'owner@example.com');
  const org = await createOrg(owner, 'Acme');
  const member = await join(owner, org, 'member@example.com', 'member');
  const viewer = await join(owner, org, 'viewer@example.com', 'viewer');
  const other = await signupAndLogin(app, 'other@example.com');
  const otherOrg = await createOrg(other, 'Globex');
  return {
    app,
    media,
    signer: media.signer as FakeMediaSigner,
    jobs: media.jobs as InMemoryMediaJobQueue,
    consents: media.consents as InMemoryConsentRepository,
    owner,
    member,
    viewer,
    other,
    org,
    otherOrg,
  };
}

export const errorOf = (r: { json: () => unknown }) => {
  const body = r.json();
  expect(Value.Check(ApiErrorEnvelope, body)).toBe(true);
  return (body as { error: { code: string; reason?: string } }).error;
};
