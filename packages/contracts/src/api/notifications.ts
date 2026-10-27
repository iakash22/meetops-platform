import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime } from '../common.js';

/** v0.10.0 (ADR-013): in-app feed, preferences, push devices and the email unsubscribe flow. */
export const NOTIFICATION_PATHS = {
  notifications: '/orgs/:organizationId/notifications',
  markRead: '/orgs/:organizationId/notifications/read',
  preferences: '/orgs/:organizationId/notification-preferences',
  pushDevices: '/orgs/:organizationId/push-devices',
  pushDevice: '/orgs/:organizationId/push-devices/:deviceId',
  /** GET renders a confirm page (no state change); POST applies (security review C, finding 5). */
  unsubscribe: '/notifications/unsubscribe',
} as const;

export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'web_push', 'mobile_push', 'desktop'] as const;
export const NotificationChannel = Type.Union(NOTIFICATION_CHANNELS.map((c) => Type.Literal(c)));
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const PUSH_PLATFORMS = ['web', 'extension', 'ios', 'android'] as const;
export const PushPlatform = Type.Union(PUSH_PLATFORMS.map((p) => Type.Literal(p)));
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

/**
 * Web Push services we deliver to (security review C, finding 1). Exact hosts, HTTPS on 443 only; anything else is
 * rejected at registration and again (with DNS / private-address checks, ADR-009 guard) before each send.
 */
export const WEB_PUSH_ALLOWED_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
] as const;
/** Expo push tokens; the worker only ever calls the fixed Expo push API URL. */
export const EXPO_PUSH_TOKEN_PATTERN = '^(ExponentPushToken|ExpoPushToken)\\[[A-Za-z0-9_-]{10,128}\\]$';
export const EXPO_PUSH_API_URL = 'https://exp.host/--/api/v2/push/send' as const;
/** Generic push copy: never titles, org names or meeting content on a lock screen (finding 3). */
export const GENERIC_PUSH_TITLE = 'MeetOps' as const;
export const GENERIC_PUSH_BODY = 'You have a new notification' as const;

const strict = { additionalProperties: false } as const;
const NotificationType = Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9_.-]*$' });
const PreferenceType = Type.Union([Type.Literal('*'), NotificationType]);

/** ids-only payload values; clients render copy from `type` + ids. */
const DataValue = Type.Union([
  Type.String({ maxLength: 200 }),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
]);

export const Notification = Type.Object(
  {
    id: Id,
    organizationId: Id,
    type: NotificationType,
    subjectType: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
    subjectId: Type.Union([Id, Type.Null()]),
    data: Type.Record(Type.String({ maxLength: 64 }), DataValue, { maxProperties: 20 }),
    readAt: Type.Union([IsoDateTime, Type.Null()]),
    createdAt: IsoDateTime,
  },
  strict,
);
export type Notification = Static<typeof Notification>;

export const NotificationOrgParams = Type.Object({ organizationId: Id }, strict);
export type NotificationOrgParams = Static<typeof NotificationOrgParams>;

export const ListNotificationsQuery = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9_-]+$' })),
    unreadOnly: Type.Optional(Type.Boolean()),
  },
  strict,
);
export type ListNotificationsQuery = Static<typeof ListNotificationsQuery>;

export const NotificationList = Type.Object(
  {
    items: Type.Array(Notification, { maxItems: 100 }),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
    unreadCount: Type.Integer({ minimum: 0 }),
  },
  strict,
);
export type NotificationList = Static<typeof NotificationList>;

/** Either explicit ids or `all: true`. */
export const MarkNotificationsReadRequest = Type.Union([
  Type.Object({ ids: Type.Array(Id, { minItems: 1, maxItems: 100, uniqueItems: true }) }, strict),
  Type.Object({ all: Type.Literal(true) }, strict),
]);
export type MarkNotificationsReadRequest = Static<typeof MarkNotificationsReadRequest>;

export const MarkNotificationsReadResponse = Type.Object({ updated: Type.Integer({ minimum: 0 }) }, strict);
export type MarkNotificationsReadResponse = Static<typeof MarkNotificationsReadResponse>;

export const NotificationPreference = Type.Object(
  { type: PreferenceType, channel: NotificationChannel, enabled: Type.Boolean() },
  strict,
);
export type NotificationPreference = Static<typeof NotificationPreference>;

export const NotificationPreferences = Type.Object(
  { items: Type.Array(NotificationPreference, { maxItems: 100 }) },
  strict,
);
export type NotificationPreferences = Static<typeof NotificationPreferences>;
export const UpdateNotificationPreferencesRequest = Type.Object(
  { items: Type.Array(NotificationPreference, { minItems: 1, maxItems: 100 }) },
  strict,
);
export type UpdateNotificationPreferencesRequest = Static<typeof UpdateNotificationPreferencesRequest>;

const WebPushSubscription = Type.Object(
  {
    endpoint: Type.String({ minLength: 12, maxLength: 2048, pattern: '^https://' }),
    keys: Type.Object(
      {
        p256dh: Type.String({ minLength: 16, maxLength: 256, pattern: '^[A-Za-z0-9_=-]+$' }),
        auth: Type.String({ minLength: 8, maxLength: 64, pattern: '^[A-Za-z0-9_=-]+$' }),
      },
      strict,
    ),
  },
  strict,
);
const DeviceLabel = Type.Optional(Type.String({ minLength: 1, maxLength: 100, pattern: '^[^\\u0000-\\u001f<>]+$' }));

/** Web/extension register a Web Push subscription; iOS/Android register an Expo push token. */
export const RegisterPushDeviceRequest = Type.Union([
  Type.Object(
    {
      platform: Type.Union([Type.Literal('web'), Type.Literal('extension')]),
      subscription: WebPushSubscription,
      label: DeviceLabel,
    },
    strict,
  ),
  Type.Object(
    {
      platform: Type.Union([Type.Literal('ios'), Type.Literal('android')]),
      expoPushToken: Type.String({ pattern: EXPO_PUSH_TOKEN_PATTERN, maxLength: 160 }),
      label: DeviceLabel,
    },
    strict,
  ),
]);
export type RegisterPushDeviceRequest = Static<typeof RegisterPushDeviceRequest>;

/** Never carries the token or subscription. */
export const PushDevice = Type.Object(
  {
    id: Id,
    platform: PushPlatform,
    label: Type.Union([Type.String(), Type.Null()]),
    lastSeenAt: IsoDateTime,
    createdAt: IsoDateTime,
  },
  strict,
);
export type PushDevice = Static<typeof PushDevice>;

export const PushDeviceParams = Type.Object({ organizationId: Id, deviceId: Id }, strict);
export type PushDeviceParams = Static<typeof PushDeviceParams>;

export const UnsubscribeQuery = Type.Object(
  { token: Type.String({ minLength: 20, maxLength: 2048, pattern: '^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$' }) },
  strict,
);
export type UnsubscribeQuery = Static<typeof UnsubscribeQuery>;
export const UnsubscribeResponse = Type.Object({ unsubscribed: Type.Literal(true) }, strict);
export type UnsubscribeResponse = Static<typeof UnsubscribeResponse>;
