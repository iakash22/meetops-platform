import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  createNotificationRepository,
  decodeNotificationCursor,
  encodeNotificationCursor,
  hashPushToken,
  type PushTokenCipher,
} from '../src/index.js';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const USER = '00000000-0000-4000-8000-0000000000b1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';

const cipher: PushTokenCipher = {
  encrypt: async (p, c) =>
    `v1.k1.${Buffer.from(`${c.organizationId}|${c.deviceId}`).toString('base64url')}.${Buffer.from(p).toString('base64url')}`,
  decrypt: async (e) => Buffer.from(e.split('.')[3] ?? '', 'base64url').toString(),
};

type Row = Record<string, unknown>;
const pick = (r: Row, sel?: Record<string, boolean>) =>
  sel ? Object.fromEntries(Object.keys(sel).map((k) => [k, r[k] ?? null])) : r;

/** Minimal in-memory Prisma double: records the GUCs set per transaction and the rows written. */
function fakeClient() {
  const notifications: Row[] = [];
  const devices: Row[] = [];
  const prefs: Row[] = [];
  const attempts: Row[] = [];
  const settings: string[][] = [];
  let current: string[] = [];
  const match = (r: Row, w: Row) =>
    Object.entries(w).every(([k, v]) => {
      if (k === 'OR' || k === 'tokenEnc') return true;
      if (v && typeof v === 'object' && 'in' in (v as Row))
        return (v as { in: unknown[] }).in.includes(r[k]);
      return r[k] === v;
    });
  const tx = {
    $executeRaw: async (_s: TemplateStringsArray, ...v: unknown[]) => {
      current.push(`${String(v[0])}=${String(v[1])}`);
      return 1;
    },
    notification: {
      findFirst: async ({ where, select }: { where: Row; select: Record<string, boolean> }) => {
        const r = notifications.find((x) => match(x, where));
        return r ? pick(r, select) : null;
      },
      upsert: async ({
        where,
        create,
        select,
      }: {
        where: { organizationId_userId_dedupeKey: Row };
        create: Row;
        select: Record<string, boolean>;
      }) => {
        let r = notifications.find((x) => match(x, where.organizationId_userId_dedupeKey));
        if (!r) {
          r = { ...create, readAt: null, createdAt: new Date(Date.now() + notifications.length) };
          notifications.push(r);
        }
        return pick(r, select);
      },
      findMany: async ({
        where,
        take,
        select,
      }: {
        where: Row;
        take: number;
        select: Record<string, boolean>;
      }) =>
        notifications
          .filter((x) => match(x, where))
          .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())
          .slice(0, take)
          .map((r) => pick(r, select)),
      count: async ({ where }: { where: Row }) =>
        notifications.filter((x) => match(x, where)).length,
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hit = notifications.filter((x) => match(x, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      },
    },
    notificationDeliveryAttempt: {
      upsert: async ({ create }: { create: Row }) => {
        attempts.push(create);
        return create;
      },
    },
    notificationPreference: {
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { organizationId_userId_type_channel: Row };
        create: Row;
        update: Row;
      }) => {
        const r = prefs.find((x) => match(x, where.organizationId_userId_type_channel));
        if (r) Object.assign(r, update);
        else prefs.push(create);
      },
      findMany: async ({ where, select }: { where: Row; select: Record<string, boolean> }) =>
        prefs.filter((x) => match(x, where)).map((r) => pick(r, select)),
    },
    pushDeviceToken: {
      findUnique: async ({ where }: { where: { organizationId_tokenHash: Row } }) =>
        devices.find((x) => match(x, where.organizationId_tokenHash)) ?? null,
      create: async ({ data, select }: { data: Row; select: Record<string, boolean> }) => {
        const r = { ...data, createdAt: new Date() };
        devices.push(r);
        return pick(r, select);
      },
      update: async ({
        where,
        data,
        select,
      }: {
        where: Row;
        data: Row;
        select: Record<string, boolean>;
      }) => {
        const r = devices.find((x) => x.id === where.id)!;
        Object.assign(r, data);
        return pick(r, select);
      },
      deleteMany: async ({ where }: { where: Row }) => {
        const before = devices.length;
        for (let i = devices.length - 1; i >= 0; i--)
          if (match(devices[i]!, where)) devices.splice(i, 1);
        return { count: before - devices.length };
      },
      findMany: async ({ where, select }: { where: Row; select: Record<string, boolean> }) =>
        devices.filter((x) => match(x, where)).map((r) => pick(r, select)),
    },
  };
  const client = {
    $transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => {
      current = [];
      settings.push(current);
      return fn(tx);
    },
  } as unknown as PrismaClient;
  return { client, notifications, devices, prefs, attempts, settings };
}

describe('notification repository', () => {
  it('creates idempotently on dedupeKey inside the org context', async () => {
    const f = fakeClient();
    const repo = createNotificationRepository({ client: f.client, cipher });
    const a = await repo.create(ORG, { userId: USER, type: 'task.assigned', dedupeKey: 'evt-1' });
    const b = await repo.create(ORG, { userId: USER, type: 'task.assigned', dedupeKey: 'evt-1' });
    expect(a.id).toBe(b.id);
    expect(f.notifications).toHaveLength(1);
    expect(f.settings[0]).toContain(`app.current_organization_id=${ORG}`);
  });

  it('lists only the caller and sets the user context (owner_only RLS)', async () => {
    const f = fakeClient();
    const repo = createNotificationRepository({ client: f.client, cipher });
    for (let i = 0; i < 3; i++)
      await repo.create(ORG, { userId: USER, type: 't', dedupeKey: `e${i}` });
    await repo.create(ORG, { userId: OTHER, type: 't', dedupeKey: 'x' });
    const page = await repo.list(ORG, USER, { limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.items.every((n) => n.userId === USER)).toBe(true);
    expect(page.unreadCount).toBe(3);
    expect(page.nextCursor).not.toBeNull();
    expect(f.settings.at(-1)).toContain(`app.current_user_id=${USER}`);
  });

  it('marks read only the callers rows and rejects bad ids', async () => {
    const f = fakeClient();
    const repo = createNotificationRepository({ client: f.client, cipher });
    const mine = await repo.create(ORG, { userId: USER, type: 't', dedupeKey: 'a' });
    const theirs = await repo.create(ORG, { userId: OTHER, type: 't', dedupeKey: 'b' });
    expect(await repo.markRead(ORG, USER, [mine.id, theirs.id])).toBe(1);
    expect(await repo.markRead(ORG, USER, 'all')).toBe(0);
    await expect(repo.markRead(ORG, USER, ['nope'])).rejects.toThrow(TypeError);
  });

  it('stores push tokens only hashed + encrypted, re-registers idempotently, deletes on revocation', async () => {
    const f = fakeClient();
    const repo = createNotificationRepository({ client: f.client, cipher });
    const token = 'ExponentPushToken[abcdefghijklmnop]';
    const d1 = await repo.registerDevice(ORG, USER, { platform: 'ios', token });
    const d2 = await repo.registerDevice(ORG, USER, { platform: 'ios', token });
    expect(d1.id).toBe(d2.id);
    expect(f.devices).toHaveLength(1);
    expect(f.devices[0]!.tokenHash).toBe(hashPushToken(token));
    expect(JSON.stringify(d1)).not.toContain('Exponent');
    expect(String(f.devices[0]!.tokenEnc)).toMatch(/^v1\.k1\./);
    const active = await repo.listActiveDevices(ORG, USER);
    expect(active[0]!.token).toBe(token);
    expect(await repo.unregisterDevice(ORG, OTHER, d1.id)).toBe(false);
    expect(await repo.deleteDevicesForUser(ORG, USER)).toBe(1);
  });

  it('upserts preferences and records attempts with bounded error codes', async () => {
    const f = fakeClient();
    const repo = createNotificationRepository({ client: f.client, cipher });
    await repo.setPreferences(ORG, USER, [{ type: '*', channel: 'email', enabled: false }]);
    const prefs = await repo.setPreferences(ORG, USER, [
      { type: '*', channel: 'email', enabled: true },
    ]);
    expect(prefs).toEqual([{ type: '*', channel: 'email', enabled: true }]);
    await repo.recordAttempt(ORG, {
      notificationId: USER,
      channel: 'email',
      deliveryKey: 'd1',
      attempt: 1,
      status: 'failed',
      errorCode: 'x'.repeat(200),
    });
    expect(String(f.attempts[0]!.errorCode)).toHaveLength(64);
    await expect(
      repo.recordAttempt(ORG, {
        notificationId: USER,
        channel: 'email',
        deliveryKey: 'd',
        attempt: 0,
        status: 'sent',
      }),
    ).rejects.toThrow(TypeError);
  });

  it('every per-user method sets app.current_user_id and fails closed without a valid user id', async () => {
    const f = fakeClient();
    const repo = createNotificationRepository({ client: f.client, cipher });
    const D = '00000000-0000-4000-8000-0000000000dd';
    const calls: Array<(u: string) => Promise<unknown>> = [
      (u) => repo.list(ORG, u, { limit: 5 }),
      (u) => repo.markRead(ORG, u, 'all'),
      (u) => repo.getPreferences(ORG, u),
      (u) => repo.setPreferences(ORG, u, [{ type: '*', channel: 'email', enabled: true }]),
      (u) => repo.unregisterDevice(ORG, u, D),
      (u) => repo.listDevices(ORG, u),
      (u) => repo.listActiveDevices(ORG, u),
    ];
    for (const call of calls) {
      const before = f.settings.length;
      await call(USER);
      expect(f.settings.length).toBe(before + 1);
      expect(f.settings.at(-1)).toContain(`app.current_user_id=${USER}`);
      for (const bad of ['', 'not-a-uuid', undefined as unknown as string]) {
        const n = f.settings.length;
        await expect(call(bad)).rejects.toThrow();
        // Rejected before any transaction: owner_only can never run with the user id unset.
        expect(f.settings.length).toBe(n);
      }
    }
  });

  it('findForUser returns only the caller own row inside the user context', async () => {
    const f = fakeClient();
    const repo = createNotificationRepository({ client: f.client, cipher });
    const mine = await repo.create(ORG, { userId: USER, type: 't', dedupeKey: 'a' });
    const theirs = await repo.create(ORG, { userId: OTHER, type: 't', dedupeKey: 'b' });
    expect((await repo.findForUser(ORG, USER, mine.id))?.id).toBe(mine.id);
    expect(f.settings.at(-1)).toContain(`app.current_user_id=${USER}`);
    expect(await repo.findForUser(ORG, USER, theirs.id)).toBeUndefined();
    await expect(repo.findForUser(ORG, '', mine.id)).rejects.toThrow();
  });

  it('round-trips cursors and rejects garbage', () => {
    const c = encodeNotificationCursor({ createdAt: new Date('2026-10-27T00:00:00Z'), id: USER });
    expect(decodeNotificationCursor(c)).toEqual({
      createdAt: new Date('2026-10-27T00:00:00Z'),
      id: USER,
    });
    expect(decodeNotificationCursor('zzz')).toBeNull();
  });
});
