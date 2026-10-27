import type { Notification, NotificationPreference, PushDevice, PushPlatform } from '@meetops/contracts';
import {
  createNotificationRepository,
  type NotificationRecord,
  type NotificationRepository,
  type PushDeviceRecord,
  type PushTokenCipher,
} from '@meetops/database';
import type { DatabaseClient } from '../../shared/prisma/context.js';
import { InvalidCursorError, NotificationsUnavailableError } from './errors.js';
import type { NotificationPage, NotificationsRepository } from './ports.js';

/** Without a configured cipher nothing can be registered (503), and nothing is ever stored in plaintext. */
export const refusingPushCipher: PushTokenCipher = {
  encrypt: () => Promise.reject(new NotificationsUnavailableError('Push token encryption')),
  decrypt: () => Promise.reject(new NotificationsUnavailableError('Push token encryption')),
};

const toDto = (r: NotificationRecord): Notification => ({
  id: r.id,
  organizationId: r.organizationId,
  type: r.type,
  subjectType: r.subjectType,
  subjectId: r.subjectId,
  data: r.data as Notification['data'],
  readAt: r.readAt ? r.readAt.toISOString() : null,
  createdAt: r.createdAt.toISOString(),
});
const toDevice = (d: PushDeviceRecord): PushDevice => ({
  id: d.id,
  platform: d.platform,
  label: d.label,
  lastSeenAt: d.lastSeenAt.toISOString(),
  createdAt: d.createdAt.toISOString(),
});

export class PrismaNotifications implements NotificationsRepository {
  private readonly repo: NotificationRepository;
  constructor(db: DatabaseClient, cipher: PushTokenCipher = refusingPushCipher) {
    this.repo = createNotificationRepository({ client: db, cipher });
  }
  async list(organizationId: string, userId: string, q: { limit?: number; cursor?: string; unreadOnly?: boolean }): Promise<NotificationPage> {
    try {
      const p = await this.repo.list(organizationId, userId, q);
      return { items: p.items.map(toDto), nextCursor: p.nextCursor, unreadCount: p.unreadCount };
    } catch (e) {
      if (e instanceof TypeError && /cursor/.test(e.message)) throw new InvalidCursorError();
      throw e;
    }
  }
  markRead(organizationId: string, userId: string, ids: readonly string[] | 'all') {
    return this.repo.markRead(organizationId, userId, ids);
  }
  getPreferences(organizationId: string, userId: string): Promise<NotificationPreference[]> {
    return this.repo.getPreferences(organizationId, userId);
  }
  setPreferences(organizationId: string, userId: string, items: readonly NotificationPreference[]) {
    return this.repo.setPreferences(organizationId, userId, items);
  }
  async registerDevice(organizationId: string, userId: string, input: { platform: PushPlatform; token: string; label: string | null }) {
    return toDevice(await this.repo.registerDevice(organizationId, userId, input));
  }
  unregisterDevice(organizationId: string, userId: string, deviceId: string) {
    return this.repo.unregisterDevice(organizationId, userId, deviceId);
  }
  deleteDevicesForUser(organizationId: string, userId: string) {
    return this.repo.deleteDevicesForUser(organizationId, userId);
  }
}
