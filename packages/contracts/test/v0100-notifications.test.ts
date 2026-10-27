import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { readFileSync } from 'node:fs';
import {
  MarkNotificationsReadRequest,
  NOTIFICATION_PATHS,
  NotificationDeliveryJobPayload,
  NotificationList,
  PushDevice,
  REDACT_KEYS,
  RegisterPushDeviceRequest,
  UpdateNotificationPreferencesRequest,
  WEB_PUSH_ALLOWED_HOSTS,
} from '../src/index.js';

const ID = '00000000-0000-4000-8000-000000000001';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

describe('v0.10.0 notifications', () => {
  it('is 0.10.0 or later', () => expect(pkg.version).toMatch(/^0\.(1\d|[2-9]\d)\.\d+$/));

  it('paths are org-scoped except the token-authenticated unsubscribe', () => {
    for (const [k, p] of Object.entries(NOTIFICATION_PATHS))
      if (k !== 'unsubscribe') expect(p).toMatch(/^\/orgs\/:organizationId\//);
  });

  it('feed list validates and rejects unknown keys', () => {
    const item = {
      id: ID,
      organizationId: ID,
      type: 'task.assigned',
      subjectType: 'task',
      subjectId: ID,
      data: { taskId: ID },
      readAt: null,
      createdAt: '2026-10-27T00:00:00.000Z',
    };
    expect(Value.Check(NotificationList, { items: [item], nextCursor: null, unreadCount: 1 })).toBe(true);
    expect(Value.Check(NotificationList, { items: [{ ...item, title: 'x' }], nextCursor: null, unreadCount: 1 })).toBe(false);
  });

  it('mark-read takes ids or all, not both or neither', () => {
    expect(Value.Check(MarkNotificationsReadRequest, { ids: [ID] })).toBe(true);
    expect(Value.Check(MarkNotificationsReadRequest, { all: true })).toBe(true);
    expect(Value.Check(MarkNotificationsReadRequest, { ids: [ID], all: true })).toBe(false);
    expect(Value.Check(MarkNotificationsReadRequest, {})).toBe(false);
  });

  it('preferences accept * or a type per known channel', () => {
    expect(Value.Check(UpdateNotificationPreferencesRequest, { items: [{ type: '*', channel: 'email', enabled: false }] })).toBe(true);
    expect(Value.Check(UpdateNotificationPreferencesRequest, { items: [{ type: '*', channel: 'sms', enabled: false }] })).toBe(false);
  });

  it('push registration: https subscriptions and Expo token format only', () => {
    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'B'.repeat(20), auth: 'a'.repeat(10) } };
    expect(Value.Check(RegisterPushDeviceRequest, { platform: 'web', subscription: sub })).toBe(true);
    expect(Value.Check(RegisterPushDeviceRequest, { platform: 'web', subscription: { ...sub, endpoint: 'http://10.0.0.1/x' } })).toBe(false);
    expect(Value.Check(RegisterPushDeviceRequest, { platform: 'ios', expoPushToken: 'ExponentPushToken[abcdefghijkl]' })).toBe(true);
    expect(Value.Check(RegisterPushDeviceRequest, { platform: 'ios', expoPushToken: 'https://evil.example' })).toBe(false);
    expect(Value.Check(RegisterPushDeviceRequest, { platform: 'ios', subscription: sub })).toBe(false);
    expect(WEB_PUSH_ALLOWED_HOSTS).toContain('fcm.googleapis.com');
    expect(REDACT_KEYS).toEqual(expect.arrayContaining(['expoPushToken', 'p256dh']));
  });

  it('device DTO never carries tokens', () => {
    expect(Object.keys(PushDevice.properties)).not.toEqual(expect.arrayContaining(['token']));
    expect(JSON.stringify(PushDevice)).not.toMatch(/token|endpoint|p256dh/i);
  });

  it('delivery jobs require an organization context', () => {
    const job = { jobVersion: 1, kind: 'deliver_notification', organizationId: ID, userId: ID, notificationId: ID, channel: 'web_push', deliveryKey: `${ID}:web_push` };
    expect(Value.Check(NotificationDeliveryJobPayload, job)).toBe(true);
    const { organizationId: _o, ...noOrg } = job;
    expect(Value.Check(NotificationDeliveryJobPayload, noOrg)).toBe(false);
  });
});
