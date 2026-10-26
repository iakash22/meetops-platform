import { describe, expect, it } from 'vitest';
import {
  createIntegrationConnectionRepository,
  type IntegrationSecretCipher,
} from '../src/index.js';

const ORG = '00000000-0000-4000-8000-0000000000a1';

/** Fake cipher producing v1 envelopes whose payload is bound to org + integration (like TokenCipher's AAD). */
const cipher: IntegrationSecretCipher = {
  encrypt: async (p, c) =>
    `v1.k1.${Buffer.from(`${c.organizationId}|${c.integrationId}`).toString('base64url')}.${Buffer.from(p).toString('base64url')}`,
  decrypt: async (e, c) => {
    const [, , aad, ct] = e.split('.');
    if (Buffer.from(aad ?? '', 'base64url').toString() !== `${c.organizationId}|${c.integrationId}`)
      throw new Error('aad');
    return Buffer.from(ct ?? '', 'base64url').toString();
  },
};

function fakeClient() {
  const rows: Record<string, unknown>[] = [];
  const settings: string[] = [];
  const pick = (r: Record<string, unknown>, sel: Record<string, boolean>) =>
    Object.fromEntries(Object.keys(sel).map((k) => [k, r[k] ?? null]));
  const tx = {
    $executeRaw: async (_s: TemplateStringsArray, ...v: unknown[]) => {
      settings.push(String(v[1]));
      return 1;
    },
    integrationConnection: {
      findUnique: async ({ where, select }: any) => {
        const k = where.organizationId_provider_externalAccountId;
        const r = rows.find(
          (x) =>
            x.organizationId === k.organizationId &&
            x.provider === k.provider &&
            x.externalAccountId === k.externalAccountId,
        );
        return r ? pick(r, select) : null;
      },
      findFirst: async ({ where, select }: any) => {
        const r = rows.find((x) => x.id === where.id && x.organizationId === where.organizationId);
        return r ? pick(r, select) : null;
      },
      create: async ({ data, select }: any) => {
        const r = { ...data, createdAt: new Date(), updatedAt: new Date() };
        rows.push(r);
        return pick(r, select);
      },
      update: async ({ where, data, select }: any) => {
        const r = rows.find((x) => x.id === where.id)!;
        Object.assign(r, data);
        return pick(r, select);
      },
    },
  };
  return { rows, settings, client: { $transaction: (fn: any) => fn(tx) } as any };
}

describe('integration connection repository', () => {
  it('stores only envelopes, binds them to org + id, and sets the org context', async () => {
    const f = fakeClient();
    const repo = createIntegrationConnectionRepository({ client: f.client, cipher });
    const rec = await repo.upsert(ORG, {
      provider: 'github',
      displayName: 'acme',
      externalAccountId: '42',
      accessToken: 'plain-access',
      refreshToken: 'plain-refresh',
      webhookSecret: 'plain-hook',
    });
    expect(f.settings).toContain(ORG);
    expect(rec.tokenKeyId).toBe('k1');
    expect(JSON.stringify(rec)).not.toMatch(/plain-|Enc/);
    const stored = JSON.stringify(f.rows);
    expect(stored).not.toMatch(/plain-access|plain-refresh|plain-hook/);
    expect(f.rows[0]?.accessTokenEnc).toMatch(/^v1\.k1\./);
    expect(await repo.readSecrets(ORG, rec.id)).toEqual({
      accessToken: 'plain-access',
      refreshToken: 'plain-refresh',
      webhookSecret: 'plain-hook',
    });
  });

  it('reconnect keeps the id and re-encrypts; bad ids read as null', async () => {
    const f = fakeClient();
    const repo = createIntegrationConnectionRepository({ client: f.client, cipher });
    const input = {
      provider: 'linear',
      displayName: 'L',
      externalAccountId: 'x',
      accessToken: 'a1',
      webhookSecret: 'w',
    };
    const a = await repo.upsert(ORG, input);
    const b = await repo.upsert(ORG, { ...input, accessToken: 'a2' });
    expect(b.id).toBe(a.id);
    expect(f.rows).toHaveLength(1);
    expect((await repo.readSecrets(ORG, a.id))?.accessToken).toBe('a2');
    expect((await repo.readSecrets(ORG, a.id))?.refreshToken).toBeNull();
    expect(await repo.get(ORG, 'not-a-uuid')).toBeNull();
  });

  it('rejects a cipher that does not return a v1 envelope', async () => {
    const f = fakeClient();
    const repo = createIntegrationConnectionRepository({
      client: f.client,
      cipher: { encrypt: async (p) => p, decrypt: async (e) => e },
    });
    await expect(
      repo.upsert(ORG, {
        provider: 'p',
        displayName: 'd',
        externalAccountId: 'e',
        accessToken: 't',
        webhookSecret: 'w',
      }),
    ).rejects.toThrow(/v1 envelope/);
    expect(f.rows).toHaveLength(0);
  });
});
