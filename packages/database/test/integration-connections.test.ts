import type { PrismaClient } from '@prisma/client';
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

type Row = Record<string, unknown>;
type Sel = Record<string, boolean>;
interface Args {
  where: Row & { organizationId_provider_externalAccountId?: Row };
  select: Sel;
  data: Row;
}

function fakeClient() {
  const rows: Row[] = [];
  const settings: string[] = [];
  const pick = (r: Row, sel: Sel) =>
    Object.fromEntries(Object.keys(sel).map((k) => [k, r[k] ?? null]));
  const tx = {
    $executeRaw: async (_s: TemplateStringsArray, ...v: unknown[]) => {
      settings.push(String(v[1]));
      return 1;
    },
    integrationConnection: {
      findUnique: async ({ where, select }: Pick<Args, 'where' | 'select'>) => {
        const k = where.organizationId_provider_externalAccountId ?? {};
        const r = rows.find(
          (x) =>
            x.organizationId === k.organizationId &&
            x.provider === k.provider &&
            x.externalAccountId === k.externalAccountId,
        );
        return r ? pick(r, select) : null;
      },
      findFirst: async ({ where, select }: Pick<Args, 'where' | 'select'>) => {
        const r = rows.find((x) => x.id === where.id && x.organizationId === where.organizationId);
        return r ? pick(r, select) : null;
      },
      create: async ({ data, select }: Pick<Args, 'data' | 'select'>) => {
        const r = { ...data, createdAt: new Date(), updatedAt: new Date() };
        rows.push(r);
        return pick(r, select);
      },
      updateMany: async ({ where, data }: Pick<Args, 'where' | 'data'>) => {
        const hit = rows.filter(
          (x) =>
            x.id === where.id &&
            x.organizationId === where.organizationId &&
            !(where.status && x.status === 'revoked'),
        );
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      },
      update: async ({ where, data, select }: Args) => {
        const r = rows.find((x) => x.id === where.id)!;
        Object.assign(r, data);
        return pick(r, select);
      },
    },
  };
  return {
    rows,
    settings,
    client: {
      $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as PrismaClient,
  };
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

  it('disconnect is a soft revoke that wipes every secret; reconnect restores the row', async () => {
    const f = fakeClient();
    const repo = createIntegrationConnectionRepository({ client: f.client, cipher });
    const input = {
      provider: 'github',
      displayName: 'acme',
      externalAccountId: '7',
      accessToken: 'a1',
      refreshToken: 'r1',
      webhookSecret: 'w1',
    };
    const a = await repo.upsert(ORG, input);
    const d = await repo.disconnect(ORG, a.id);
    expect(d?.status).toBe('revoked');
    expect(d?.revokedAt).toBeInstanceOf(Date);
    expect(f.rows[0]).toMatchObject({
      accessTokenEnc: null,
      refreshTokenEnc: null,
      webhookSecretEnc: null,
    });
    expect(JSON.stringify(f.rows)).not.toMatch(/v1\./);
    expect(await repo.readSecrets(ORG, a.id)).toBeNull();
    expect((await repo.disconnect(ORG, a.id))?.status).toBe('revoked');
    expect(await repo.disconnect(ORG, 'bad')).toBeNull();
    await expect(repo.setStatus(ORG, a.id, 'revoked' as 'active')).rejects.toThrow(/disconnect/);
    expect('remove' in repo).toBe(false);
    const b = await repo.upsert(ORG, { ...input, accessToken: 'a2' });
    expect(b).toMatchObject({ id: a.id, status: 'active', revokedAt: null });
    expect((await repo.readSecrets(ORG, a.id))?.accessToken).toBe('a2');
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
