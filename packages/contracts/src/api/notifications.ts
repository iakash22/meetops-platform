import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime } from '../common.js';
import { GeoName } from './sessions.js';

/** v0.11.0 (ADR-013): in-app feed, preferences, push devices and the email unsubscribe flow. */
export const NOTIFICATION_PATHS = {
  notifications: '/orgs/:organizationId/notifications',
  markRead: '/orgs/:organizationId/notifications/:notificationId/read',
  markAllRead: '/orgs/:organizationId/notifications/read-all',
  preferences: '/orgs/:organizationId/notification-preferences',
  /** Mobile PR #262: user-facing paths; the device is bound to the session's active organization (forced RLS). */
  pushDevices: '/me/push-devices',
  pushDevice: '/me/push-devices/:id',
  /** GET renders a confirm page (no state change); POST applies (security review C, finding 5). */
  unsubscribe: '/notifications/unsubscribe',
} as const;

export const NOTIFICATION_CHANNELS = [
  'in_app',
  'email',
  'web_push',
  'mobile_push',
  'desktop',
] as const;
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
export const EXPO_PUSH_TOKEN_PATTERN =
  '^(ExponentPushToken|ExpoPushToken)\\[[A-Za-z0-9_-]{10,128}\\]$';
export const EXPO_PUSH_API_URL = 'https://exp.host/--/api/v2/push/send' as const;
/** Generic push copy: never titles, org names or meeting content on a lock screen (finding 3). */
export const GENERIC_PUSH_TITLE = 'MeetOps' as const;
export const GENERIC_PUSH_BODY = 'You have a new notification' as const;

const strict = { additionalProperties: false } as const;
const NotificationType = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^[a-z][a-z0-9_.-]*$',
});
const PreferenceType = Type.Union([Type.Literal('*'), NotificationType]);

/**
 * Feed item (web PR #260 shape). `title` / `body` are rendered by the API from `kind` + ids (no stored free text);
 * `meetingId` / `taskId` are present only when the notification points at one.
 */
export const Notification = Type.Object(
  {
    id: Id,
    organizationId: Id,
    kind: NotificationType,
    title: Type.String({ minLength: 1, maxLength: 200 }),
    body: Type.Optional(Type.String({ maxLength: 1000 })),
    meetingId: Type.Optional(Id),
    taskId: Type.Optional(Id),
    /** v0.14.0 (ADR-014), `auth.new_location_signin` only: coarse location, optional (absent = unknown). No IP. */
    geoCity: Type.Optional(GeoName),
    geoCountry: Type.Optional(GeoName),
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
    cursor: Type.Optional(
      Type.String({ minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9_-]+$' }),
    ),
    unreadOnly: Type.Optional(Type.Boolean()),
  },
  strict,
);
export type ListNotificationsQuery = Static<typeof ListNotificationsQuery>;

export const NotificationList = Type.Object(
  {
    items: Type.Array(Notification, { maxItems: 100 }),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
  },
  strict,
);
export type NotificationList = Static<typeof NotificationList>;

export const NotificationParams = Type.Object({ organizationId: Id, notificationId: Id }, strict);
export type NotificationParams = Static<typeof NotificationParams>;

/** Both mark-read routes take no body and return how many rows changed (0 when already read). */
export const MarkNotificationsReadResponse = Type.Object(
  { updated: Type.Integer({ minimum: 0 }) },
  strict,
);
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
export type UpdateNotificationPreferencesRequest = Static<
  typeof UpdateNotificationPreferencesRequest
>;

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
const DeviceName = Type.Optional(
  Type.String({ minLength: 1, maxLength: 100, pattern: '^[^\\u0000-\\u001f<>]+$' }),
);

/**
 * POST /me/push-devices (mobile PR #262). `provider: 'expo'` takes an Expo push token (ExponentPushToken[...] /
 * ExpoPushToken[...]) for iOS/Android; `provider: 'webpush'` takes a Web Push subscription on an allowlisted host for
 * web/extension. Anything else is rejected.
 */
export const RegisterPushDeviceRequest = Type.Union([
  Type.Object(
    {
      provider: Type.Literal('expo'),
      token: Type.String({ pattern: EXPO_PUSH_TOKEN_PATTERN, maxLength: 160 }),
      platform: Type.Union([Type.Literal('ios'), Type.Literal('android')]),
      deviceName: DeviceName,
    },
    strict,
  ),
  Type.Object(
    {
      provider: Type.Literal('webpush'),
      subscription: WebPushSubscription,
      platform: Type.Union([Type.Literal('web'), Type.Literal('extension')]),
      deviceName: DeviceName,
    },
    strict,
  ),
]);
export type RegisterPushDeviceRequest = Static<typeof RegisterPushDeviceRequest>;

/** Registration result; never carries the token or subscription. */
export const PushDevice = Type.Object(
  { id: Id, platform: PushPlatform, createdAt: IsoDateTime },
  strict,
);
export type PushDevice = Static<typeof PushDevice>;

/** DELETE /me/push-devices/:id: idempotent 204; only the caller's own devices are affected. */
export const PushDeviceParams = Type.Object({ id: Id }, strict);
export type PushDeviceParams = Static<typeof PushDeviceParams>;

export const UnsubscribeQuery = Type.Object(
  {
    token: Type.String({
      minLength: 20,
      maxLength: 2048,
      pattern: '^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$',
    }),
  },
  strict,
);
export type UnsubscribeQuery = Static<typeof UnsubscribeQuery>;
export const UnsubscribeResponse = Type.Object({ unsubscribed: Type.Literal(true) }, strict);
export type UnsubscribeResponse = Static<typeof UnsubscribeResponse>;
