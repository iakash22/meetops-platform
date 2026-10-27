import type {
  Notification,
  NotificationPreference,
  PushDevice,
  PushPlatform,
} from '@meetops/contracts';

export interface NotificationPage {
  items: Notification[];
  nextCursor: string | null;
  unreadCount: number;
}

/**
 * ADR-013 persistence used by the API. Every method is scoped to (organization, user): the Prisma adapter runs it in
 * withOrganizationContext with the user GUC set, so forced RLS + the owner_only policy apply.
 */
export interface NotificationsRepository {
  list(
    organizationId: string,
    userId: string,
    q: { limit?: number; cursor?: string; unreadOnly?: boolean },
  ): Promise<NotificationPage>;
  markRead(organizationId: string, userId: string, ids: readonly string[] | 'all'): Promise<number>;
  getPreferences(organizationId: string, userId: string): Promise<NotificationPreference[]>;
  setPreferences(
    organizationId: string,
    userId: string,
    items: readonly NotificationPreference[],
  ): Promise<NotificationPreference[]>;
  registerDevice(
    organizationId: string,
    userId: string,
    input: { platform: PushPlatform; token: string; label: string | null },
  ): Promise<PushDevice>;
  unregisterDevice(organizationId: string, userId: string, deviceId: string): Promise<boolean>;
  /** Membership revocation (security review C, finding 3). */
  deleteDevicesForUser(organizationId: string, userId: string): Promise<number>;
}
