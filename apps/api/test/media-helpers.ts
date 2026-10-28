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

/**
 * `emailTag` makes the four users' emails and the two org names (#302 L-2b) unique (e.g. per run) so live suites can share one database (#302 L-2).
 */
export async function mediaWorld(
  extra: Partial<ModuleDeps> = {},
  emailTag = '',
): Promise<MediaWorld> {
  const email = (u: string) => (emailTag ? `${u}+${emailTag}@example.com` : `${u}@example.com`);
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
  const owner = await signupAndLogin(app, email('owner'));
  const org = await createOrg(owner, emailTag ? `Acme ${emailTag}` : 'Acme');
  const member = await join(owner, org, email('member'), 'member');
  const viewer = await join(owner, org, email('viewer'), 'viewer');
  const other = await signupAndLogin(app, email('other'));
  const otherOrg = await createOrg(other, emailTag ? `Globex ${emailTag}` : 'Globex');
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
