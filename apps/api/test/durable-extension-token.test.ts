import { describe, expect, it } from 'vitest';
import type { createAuthTokenRepository } from '@meetops/database';
import {
  DurableExtensionTokenRepository,
  InMemoryExtensionTokenRepository,
} from '../src/modules/extension-auth/index.js';
import type { TokenFamily } from '../src/modules/extension-auth/domain/extension-token.js';

type Store = ReturnType<typeof createAuthTokenRepository>;

const ORG = '00000000-0000-4000-8000-0000000000a1';
const FAM = '00000000-0000-4000-8000-0000000000f1';
const H1 = 'a'.repeat(64);

/** Minimal in-memory stand-in for the Postgres store, keyed by org to mirror RLS. */
function fakeDurable() {
  const fams = new Map<string, { org: string; f: TokenFamily }>();
  const refresh = new Map<string, { org: string; familyId: string; consumed: boolean }>();
  const calls: string[] = [];
  const store = {
    async createFamily(org: string, input: Parameters<Store['createFamily']>[1]) {
      calls.push('createFamily');
      fams.set(input.id, {
        org,
        f: {
          id: input.id,
          userId: input.device.userId,
          organizationId: org,
          extensionId: input.device.clientId,
          deviceId: input.device.deviceId,
          deviceLabel: input.device.label,
          scopes: input.scopes as TokenFamily['scopes'],
          createdAt: input.createdAt,
          maxExpiresAt: input.maxExpiresAt,
          revokedAt: null,
        },
      });
    },
    async findFamily(org: string, id: string) {
      const r = fams.get(id);
      if (!r || r.org !== org) return null;
      return { ...r.f, clientId: r.f.extensionId, audience: 'extension' as const };
    },
    async listFamilies(org: string, userId: string, now: Date) {
      return [...fams.values()]
        .filter(
          (r) => r.org === org && r.f.userId === userId && !r.f.revokedAt && r.f.maxExpiresAt > now,
        )
        .map((r) => ({ ...r.f, clientId: r.f.extensionId, audience: 'extension' as const }));
    },
    async revokeFamily(org: string, id: string, at: Date) {
      const r = fams.get(id);
      if (r && r.org === org && !r.f.revokedAt) r.f.revokedAt = at;
    },
    async saveRefresh(org: string, hash: string, familyId: string) {
      refresh.set(hash, { org, familyId, consumed: false });
    },
    async consumeRefresh(org: string, hash: string) {
      const r = refresh.get(hash);
      if (!r || r.org !== org) return { status: 'unknown' as const };
      const was = r.consumed;
      r.consumed = true;
      return { status: was ? ('reused' as const) : ('ok' as const), familyId: r.familyId };
    },
    async peekRefresh() {
      return { status: 'unknown' as const };
    },
  } as unknown as Store;
  return { store, fams, refresh, calls };
}

const family = (): TokenFamily => ({
  id: FAM,
  userId: '00000000-0000-4000-8000-0000000000u1'.replace('u', 'b'),
  organizationId: ORG,
  extensionId: 'ext-id',
  deviceId: '00000000-0000-4000-8000-0000000000d1',
  deviceLabel: null,
  scopes: [],
  createdAt: new Date('2026-10-26T00:00:00Z'),
  maxExpiresAt: new Date('2099-01-01T00:00:00Z'),
  revokedAt: null,
});

describe('DurableExtensionTokenRepository', () => {
  it('writes families and refresh hashes through to the durable store', async () => {
    const d = fakeDurable();
    const repo = new DurableExtensionTokenRepository(
      new InMemoryExtensionTokenRepository(),
      d.store,
    );
    await repo.createFamily(family());
    await repo.saveRefresh(H1, FAM, new Date('2099-01-01T00:00:00Z'));
    expect(d.fams.get(FAM)?.org).toBe(ORG);
    expect(d.refresh.get(H1)).toMatchObject({ org: ORG, familyId: FAM, consumed: false });
    expect(await repo.consumeRefresh(H1)).toEqual({ status: 'ok', familyId: FAM });
    expect(d.refresh.get(H1)?.consumed).toBe(true);
  });

  it('treats the durable store as authoritative for reuse', async () => {
    const d = fakeDurable();
    const repo = new DurableExtensionTokenRepository(
      new InMemoryExtensionTokenRepository(),
      d.store,
    );
    await repo.createFamily(family());
    await repo.saveRefresh(H1, FAM, new Date('2099-01-01T00:00:00Z'));
    d.refresh.get(H1)!.consumed = true; // consumed durably, e.g. before a Redis restore
    expect(await repo.consumeRefresh(H1)).toEqual({ status: 'reused', familyId: FAM });
  });

  it('reports revocation from the durable store even if Redis missed it', async () => {
    const d = fakeDurable();
    const repo = new DurableExtensionTokenRepository(
      new InMemoryExtensionTokenRepository(),
      d.store,
    );
    await repo.createFamily(family());
    d.fams.get(FAM)!.f.revokedAt = new Date('2026-10-26T01:00:00Z');
    expect((await repo.findFamily(FAM))?.revokedAt).toEqual(new Date('2026-10-26T01:00:00Z'));
  });

  it('revokes in both stores and lists durable-only families for an org', async () => {
    const d = fakeDurable();
    const fast = new InMemoryExtensionTokenRepository();
    const repo = new DurableExtensionTokenRepository(fast, d.store);
    await d.store.createFamily(ORG, {
      id: FAM,
      device: {
        userId: family().userId,
        audience: 'extension',
        clientId: 'ext-id',
        deviceId: family().deviceId,
        label: null,
      },
      scopes: [],
      createdAt: family().createdAt,
      maxExpiresAt: family().maxExpiresAt,
    });
    const listed = await repo.listFamilies(family().userId, new Date('2026-10-27T00:00:00Z'), ORG);
    expect(listed.map((f) => f.id)).toEqual([FAM]);
    await fast.createFamily(family());
    await repo.revokeFamily(FAM, new Date('2026-10-26T02:00:00Z'));
    expect(d.fams.get(FAM)?.f.revokedAt).toEqual(new Date('2026-10-26T02:00:00Z'));
    expect((await fast.findFamily(FAM))?.revokedAt).toEqual(new Date('2026-10-26T02:00:00Z'));
  });

  it('does not touch the durable store for pairing or access tokens', async () => {
    const d = fakeDurable();
    const repo = new DurableExtensionTokenRepository(
      new InMemoryExtensionTokenRepository(),
      d.store,
    );
    await repo.saveAccess(H1, {
      familyId: FAM,
      userId: family().userId,
      organizationId: ORG,
      scopes: [],
      expiresAt: new Date('2099-01-01T00:00:00Z'),
    });
    expect(d.calls).toEqual([]);
  });
});
