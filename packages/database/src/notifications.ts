import { createHash, randomUUID } from 'node:crypto';
import type {
  NotificationChannel,
  NotificationDeliveryStatus,
  Prisma,
  PushPlatform,
} from '@prisma/client';
import { getPrismaClient } from './client.js';
import { assertUuid, runWithOrganizationContext } from './tenant.js';
import type { RepositoryOptions } from './transcript-repository.js';

/**
 * ADR-013 persistence. Every call runs in runWithOrganizationContext (forced tenant RLS). Calls made on behalf of a
 * user also set app.current_user_id, so the restrictive `owner_only` policy limits rows to that user even if a query
 * forgot its user filter. Push tokens are stored only as a SHA-256 hash plus a cipher envelope (ADR-008, AAD = org +
 * row id); plaintext is returned only by `listActiveDevices` for the delivery worker.
 */
export type NotificationChannelValue = NotificationChannel;
export type NotificationDeliveryStatusValue = NotificationDeliveryStatus;
export type PushPlatformValue = PushPlatform;

export interface PushTokenCipher {
  encrypt(plaintext: string, ctx: { organizationId: string; deviceId: string }): Promise<string>;
  decrypt(envelope: string, ctx: { organizationId: string; deviceId: string }): Promise<string>;
}

export interface NotificationRecord {
  id: string;
  organizationId: string;
  userId: string;
  type: string;
  subjectType: string | null;
  subjectId: string | null;
  data: Record<string, unknown>;
  readAt: Date | null;
  createdAt: Date;
}

export interface CreateNotificationInput {
  userId: string;
  type: string;
  dedupeKey: string;
  subjectType?: string | null;
  subjectId?: string | null;
  data?: Record<string, string | number | boolean | null>;
}

export interface ListNotificationsInput {
  limit?: number;
  cursor?: string | null;
  unreadOnly?: boolean;
}

export interface NotificationPage {
  items: NotificationRecord[];
  nextCursor: string | null;
  unreadCount: number;
}

export interface NotificationPreferenceRecord {
  type: string;
  channel: NotificationChannel;
  enabled: boolean;
}

export interface PushDeviceRecord {
  id: string;
  organizationId: string;
  userId: string;
  platform: PushPlatform;
  label: string | null;
  lastSeenAt: Date;
  createdAt: Date;
}

export interface RegisterPushDeviceInput {
  platform: PushPlatform;
  /** Web Push subscription JSON or Expo push token, already validated by the caller. */
  token: string;
  label?: string | null;
}

export interface RecordAttemptInput {
  notificationId: string;
  channel: NotificationChannel;
  deliveryKey: string;
  attempt: number;
  status: NotificationDeliveryStatus;
  pushDeviceTokenId?: string | null;
  providerMessageId?: string | null;
  errorCode?: string | null;
}

export interface NotificationRepositoryOptions extends RepositoryOptions {
  cipher: PushTokenCipher;
}

export const NOTIFICATIONS_DEFAULT_PAGE_LIMIT = 20;
export const NOTIFICATIONS_MAX_PAGE_LIMIT = 100;
export const NOTIFICATION_PREFERENCES_MAX = 100;
const ERROR_CODE_MAX = 64;

const NOTIFICATION_SELECT = {
  id: true,
  organizationId: true,
  userId: true,
  type: true,
  subjectType: true,
  subjectId: true,
  data: true,
  readAt: true,
  createdAt: true,
} as const satisfies Prisma.NotificationSelect;

const DEVICE_SELECT = {
  id: true,
  organizationId: true,
  userId: true,
  platform: true,
  label: true,
  lastSeenAt: true,
  createdAt: true,
} as const satisfies Prisma.PushDeviceTokenSelect;

/** SHA-256 hex of the raw token; used for idempotent registration without storing plaintext. */
export function hashPushToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function encodeNotificationCursor(r: { createdAt: Date; id: string }): string {
  return Buffer.from(`${r.createdAt.toISOString()}|${r.id}`).toString('base64url');
}

export function decodeNotificationCursor(cursor: string): { createdAt: Date; id: string } | null {
  if (cursor.length > 200) return null;
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!iso || !id) return null;
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime())) return null;
  try {
    assertUuid(id, 'cursor');
  } catch {
    return null;
  }
  return { createdAt, id };
}

const toRecord = (r: {
  data: Prisma.JsonValue;
} & Omit<NotificationRecord, 'data'>): NotificationRecord => ({
  ...r,
  data:
    r.data && typeof r.data === 'object' && !Array.isArray(r.data)
      ? (r.data)
      : {},
});

export function createNotificationRepository(options: NotificationRepositoryOptions) {
  const { cipher } = options;
  const client = () => options.client ?? getPrismaClient();
  const timeout = options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {};
  /** Org context only (worker / fan-out). */
  const org = <T>(organizationId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    runWithOrganizationContext(client(), organizationId, fn, timeout);
  /** Org + user context: owner_only RLS applies as well. */
  const self = <T>(
    organizationId: string,
    userId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ) => runWithOrganizationContext(client(), organizationId, fn, { ...timeout, userId });

  return {
    /** Idempotent on (org, user, dedupeKey): a replayed event returns the existing row. */
    async create(organizationId: string, input: CreateNotificationInput): Promise<NotificationRecord> {
      assertUuid(input.userId, 'userId');
      if (!input.type.trim() || !input.dedupeKey.trim()) throw new TypeError('type and dedupeKey are required');
      return org(organizationId, async (tx) => {
        const row = await tx.notification.upsert({
          where: {
            organizationId_userId_dedupeKey: {
              organizationId,
              userId: input.userId,
              dedupeKey: input.dedupeKey,
            },
          },
          create: {
            id: randomUUID(),
            organizationId,
            userId: input.userId,
            type: input.type,
            dedupeKey: input.dedupeKey,
            subjectType: input.subjectType ?? null,
            subjectId: input.subjectId ?? null,
            data: (input.data ?? {}),
          },
          update: {},
          select: NOTIFICATION_SELECT,
        });
        return toRecord(row);
      });
    },

    /** Newest first, keyset paginated on (createdAt, id). */
    async list(
      organizationId: string,
      userId: string,
      input: ListNotificationsInput = {},
    ): Promise<NotificationPage> {
      const limit = Math.min(
        Math.max(1, Math.trunc(input.limit ?? NOTIFICATIONS_DEFAULT_PAGE_LIMIT)),
        NOTIFICATIONS_MAX_PAGE_LIMIT,
      );
      const cursor = input.cursor ? decodeNotificationCursor(input.cursor) : null;
      if (input.cursor && !cursor) throw new TypeError('invalid cursor');
      return self(organizationId, userId, async (tx) => {
        const base: Prisma.NotificationWhereInput = {
          organizationId,
          userId,
          ...(input.unreadOnly ? { readAt: null } : {}),
        };
        const where: Prisma.NotificationWhereInput = cursor
          ? {
              ...base,
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : base;
        const rows = await tx.notification.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
          select: NOTIFICATION_SELECT,
        });
        const unreadCount = await tx.notification.count({
          where: { organizationId, userId, readAt: null },
        });
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        return {
          items: page.map(toRecord),
          nextCursor: rows.length > limit && last ? encodeNotificationCursor(last) : null,
          unreadCount,
        };
      });
    },

    /** Marks the given ids (or every unread one when ids is 'all') read. Other users' ids are silently ignored. */
    async markRead(
      organizationId: string,
      userId: string,
      ids: readonly string[] | 'all',
      now: Date = new Date(),
    ): Promise<number> {
      if (ids !== 'all') for (const id of ids) assertUuid(id, 'notificationId');
      return self(organizationId, userId, async (tx) => {
        const r = await tx.notification.updateMany({
          where: {
            organizationId,
            userId,
            readAt: null,
            ...(ids === 'all' ? {} : { id: { in: [...ids] } }),
          },
          data: { readAt: now },
        });
        return r.count;
      });
    },

    async recordAttempt(organizationId: string, input: RecordAttemptInput): Promise<void> {
      if (!Number.isInteger(input.attempt) || input.attempt < 1) throw new TypeError('attempt must be >= 1');
      const done = input.status === 'pending' ? null : new Date();
      const errorCode = input.errorCode ? input.errorCode.slice(0, ERROR_CODE_MAX) : null;
      await org(organizationId, async (tx) => {
        await tx.notificationDeliveryAttempt.upsert({
          where: {
            organizationId_deliveryKey_attempt: {
              organizationId,
              deliveryKey: input.deliveryKey,
              attempt: input.attempt,
            },
          },
          create: {
            id: randomUUID(),
            organizationId,
            notificationId: input.notificationId,
            channel: input.channel,
            deliveryKey: input.deliveryKey,
            attempt: input.attempt,
            status: input.status,
            pushDeviceTokenId: input.pushDeviceTokenId ?? null,
            providerMessageId: input.providerMessageId ?? null,
            errorCode,
            completedAt: done,
          },
          update: {
            status: input.status,
            providerMessageId: input.providerMessageId ?? null,
            errorCode,
            completedAt: done,
          },
        });
      });
    },

    async getPreferences(organizationId: string, userId: string): Promise<NotificationPreferenceRecord[]> {
      return self(organizationId, userId, (tx) =>
        tx.notificationPreference.findMany({
          where: { organizationId, userId },
          orderBy: [{ type: 'asc' }, { channel: 'asc' }],
          take: NOTIFICATION_PREFERENCES_MAX,
          select: { type: true, channel: true, enabled: true },
        }),
      );
    },

    /** Upserts each (type, channel) and returns the full list. */
    async setPreferences(
      organizationId: string,
      userId: string,
      items: readonly NotificationPreferenceRecord[],
    ): Promise<NotificationPreferenceRecord[]> {
      if (items.length > NOTIFICATION_PREFERENCES_MAX) throw new TypeError('too many preferences');
      return self(organizationId, userId, async (tx) => {
        for (const p of items) {
          await tx.notificationPreference.upsert({
            where: {
              organizationId_userId_type_channel: {
                organizationId,
                userId,
                type: p.type,
                channel: p.channel,
              },
            },
            create: { id: randomUUID(), organizationId, userId, type: p.type, channel: p.channel, enabled: p.enabled },
            update: { enabled: p.enabled },
          });
        }
        return tx.notificationPreference.findMany({
          where: { organizationId, userId },
          orderBy: [{ type: 'asc' }, { channel: 'asc' }],
          take: NOTIFICATION_PREFERENCES_MAX,
          select: { type: true, channel: true, enabled: true },
        });
      });
    },

    /**
     * Register (or refresh) a device. Idempotent on (org, token hash). A token already registered by another user
     * in this org is re-bound to the caller (the device changed hands) and re-encrypted.
     */
    async registerDevice(
      organizationId: string,
      userId: string,
      input: RegisterPushDeviceInput,
      now: Date = new Date(),
    ): Promise<PushDeviceRecord> {
      assertUuid(userId, 'userId');
      const tokenHash = hashPushToken(input.token);
      // Org context only: the previous owner's row must be visible to re-bind it.
      return org(organizationId, async (tx) => {
        const existing = await tx.pushDeviceToken.findUnique({
          where: { organizationId_tokenHash: { organizationId, tokenHash } },
          select: { id: true },
        });
        const id = existing?.id ?? randomUUID();
        const tokenEnc = await cipher.encrypt(input.token, { organizationId, deviceId: id });
        const tokenKeyId = /^v1\.([A-Za-z0-9_-]+)\./.exec(tokenEnc)?.[1];
        if (!tokenKeyId) throw new Error('cipher returned a value that is not a v1 envelope');
        const data = {
          userId,
          platform: input.platform,
          tokenEnc,
          tokenKeyId,
          label: input.label ?? null,
          lastSeenAt: now,
          revokedAt: null,
        };
        return existing
          ? tx.pushDeviceToken.update({ where: { id }, data, select: DEVICE_SELECT })
          : tx.pushDeviceToken.create({
              data: { id, organizationId, tokenHash, ...data },
              select: DEVICE_SELECT,
            });
      });
    },

    /** Hard delete of the caller's own device. False when not found (or another user's). */
    async unregisterDevice(organizationId: string, userId: string, deviceId: string): Promise<boolean> {
      assertUuid(deviceId, 'deviceId');
      return self(organizationId, userId, async (tx) => {
        const r = await tx.pushDeviceToken.deleteMany({ where: { organizationId, userId, id: deviceId } });
        return r.count > 0;
      });
    },

    async listDevices(organizationId: string, userId: string): Promise<PushDeviceRecord[]> {
      return self(organizationId, userId, (tx) =>
        tx.pushDeviceToken.findMany({
          where: { organizationId, userId, revokedAt: null },
          orderBy: { createdAt: 'asc' },
          take: 50,
          select: DEVICE_SELECT,
        }),
      );
    },

    /** Security review C (3): membership revocation deletes every device the user registered in that org. */
    async deleteDevicesForUser(organizationId: string, userId: string): Promise<number> {
      assertUuid(userId, 'userId');
      return org(organizationId, async (tx) => {
        const r = await tx.pushDeviceToken.deleteMany({ where: { organizationId, userId } });
        return r.count;
      });
    },

    /** Worker only: decrypted tokens of the user's active devices. Never log or return these over HTTP. */
    async listActiveDevices(
      organizationId: string,
      userId: string,
    ): Promise<Array<PushDeviceRecord & { token: string }>> {
      const rows = await self(organizationId, userId, (tx) =>
        tx.pushDeviceToken.findMany({
          where: { organizationId, userId, revokedAt: null, tokenEnc: { not: null } },
          orderBy: { createdAt: 'asc' },
          take: 50,
          select: { ...DEVICE_SELECT, tokenEnc: true },
        }),
      );
      const out: Array<PushDeviceRecord & { token: string }> = [];
      for (const { tokenEnc, ...r } of rows) {
        if (!tokenEnc) continue;
        out.push({ ...r, token: await cipher.decrypt(tokenEnc, { organizationId, deviceId: r.id }) });
      }
      return out;
    },
  };
}

export type NotificationRepository = ReturnType<typeof createNotificationRepository>;
