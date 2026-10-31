import { createHash, randomUUID } from 'node:crypto';
import type { NotificationPreference, PushDevice, PushPlatform } from '@meetops/contracts';
import { renderNotification, type StoredNotification } from './render.js';
import type { NotificationPage, NotificationsRepository } from './ports.js';

type NotificationRow = StoredNotification & { userId: string };
type DeviceRow = PushDevice & { organizationId: string; userId: string; tokenHash: string; label: string | null; lastSeenAt: string };

/** Dev/test only (selectNotificationsRepository refuses it outside development/test). */
export class InMemoryNotifications implements NotificationsRepository {
  readonly notifications: NotificationRow[] = [];
  readonly prefs = new Map<string, NotificationPreference>();
  readonly devices: DeviceRow[] = [];

  add(row: NotificationRow) {
    this.notifications.push(row);
  }

  async list(organizationId: string, userId: string, q: { limit?: number; cursor?: string; unreadOnly?: boolean }): Promise<NotificationPage> {
    const mine = this.notifications
      .filter((n) => n.organizationId === organizationId && n.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const filtered = q.unreadOnly ? mine.filter((n) => !n.readAt) : mine;
    const start = q.cursor ? Number(Buffer.from(q.cursor, 'base64url').toString()) : 0;
    const limit = q.limit ?? 20;
    const page = filtered.slice(start, start + limit);
    return {
      items: page.map(renderNotification),
      nextCursor: start + limit < filtered.length ? Buffer.from(String(start + limit)).toString('base64url') : null,
    };
  }

  async markRead(organizationId: string, userId: string, ids: readonly string[] | 'all') {
    let n = 0;
    for (const r of this.notifications) {
      if (r.organizationId !== organizationId || r.userId !== userId || r.readAt) continue;
      if (ids !== 'all' && !ids.includes(r.id)) continue;
      r.readAt = new Date().toISOString();
      n++;
    }
    return n;
  }

  private key = (o: string, u: string, p: { type: string; channel: string }) => `${o}|${u}|${p.type}|${p.channel}`;
  async getPreferences(organizationId: string, userId: string) {
    return [...this.prefs.entries()]
      .filter(([k]) => k.startsWith(`${organizationId}|${userId}|`))
      .map(([, v]) => v)
      .sort((a, b) => a.type.localeCompare(b.type) || a.channel.localeCompare(b.channel));
  }
  async setPreferences(organizationId: string, userId: string, items: readonly NotificationPreference[]) {
    for (const p of items) this.prefs.set(this.key(organizationId, userId, p), { ...p });
    return this.getPreferences(organizationId, userId);
  }

  async registerDevice(organizationId: string, userId: string, input: { platform: PushPlatform; token: string; label: string | null }) {
    const tokenHash = createHash('sha256').update(input.token).digest('hex');
    const now = new Date().toISOString();
    let d = this.devices.find((x) => x.organizationId === organizationId && x.tokenHash === tokenHash);
    if (d) Object.assign(d, { userId, platform: input.platform, label: input.label, lastSeenAt: now });
    else {
      d = { id: randomUUID(), organizationId, userId, tokenHash, platform: input.platform, label: input.label, lastSeenAt: now, createdAt: now };
      this.devices.push(d);
    }
    return { id: d.id, platform: d.platform, createdAt: d.createdAt };
  }
  async unregisterDevice(organizationId: string, userId: string, deviceId: string) {
    const i = this.devices.findIndex((x) => x.organizationId === organizationId && x.userId === userId && x.id === deviceId);
    if (i < 0) return false;
    this.devices.splice(i, 1);
    return true;
  }
  async deleteDevicesForUser(organizationId: string, userId: string) {
    const before = this.devices.length;
    for (let i = this.devices.length - 1; i >= 0; i--) {
      const d = this.devices[i]!;
      if (d.organizationId === organizationId && d.userId === userId) this.devices.splice(i, 1);
    }
    return before - this.devices.length;
  }
}
