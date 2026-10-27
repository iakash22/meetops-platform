import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { readFileSync } from 'node:fs';
import {
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
      if (k === 'unsubscribe') continue;
      else if (k.startsWith('pushDevice')) expect(p).toMatch(/^\/me\/push-devices/);
      else expect(p).toMatch(/^\/orgs\/:organizationId\//);
  });

  it('feed list matches the web PR #260 shape and rejects unknown keys', () => {
    const item = {
      id: ID,
      organizationId: ID,
      kind: 'task.assigned',
      title: 'A task was assigned to you',
      taskId: ID,
      readAt: null,
      createdAt: '2026-10-27T00:00:00.000Z',
    };
    expect(Value.Check(NotificationList, { items: [item], nextCursor: null })).toBe(true);
    expect(Value.Check(NotificationList, { items: [{ ...item, body: 'x', meetingId: ID }], nextCursor: 'abc' })).toBe(true);
    expect(Value.Check(NotificationList, { items: [{ ...item, data: {} }], nextCursor: null })).toBe(false);
    expect(NOTIFICATION_PATHS.markRead).toBe('/orgs/:organizationId/notifications/:notificationId/read');
    expect(NOTIFICATION_PATHS.markAllRead).toBe('/orgs/:organizationId/notifications/read-all');
  });

  it('preferences accept * or a type per known channel', () => {
    expect(Value.Check(UpdateNotificationPreferencesRequest, { items: [{ type: '*', channel: 'email', enabled: false }] })).toBe(true);
    expect(Value.Check(UpdateNotificationPreferencesRequest, { items: [{ type: '*', channel: 'sms', enabled: false }] })).toBe(false);
  });

  it('push registration (mobile PR #262): Expo token format, or an https Web Push subscription', () => {
    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'B'.repeat(20), auth: 'a'.repeat(10) } };
    expect(Value.Check(RegisterPushDeviceRequest, { provider: 'expo', token: 'ExponentPushToken[abcdefghijkl]', platform: 'ios', deviceName: 'Pixel' })).toBe(true);
    expect(Value.Check(RegisterPushDeviceRequest, { provider: 'expo', token: 'ExpoPushToken[abcdefghijkl]', platform: 'android' })).toBe(true);
    expect(Value.Check(RegisterPushDeviceRequest, { provider: 'expo', token: 'https://evil.example', platform: 'ios' })).toBe(false);
    expect(Value.Check(RegisterPushDeviceRequest, { provider: 'fcm', token: 'x'.repeat(20), platform: 'android' })).toBe(false);
    expect(Value.Check(RegisterPushDeviceRequest, { provider: 'webpush', subscription: sub, platform: 'web' })).toBe(true);
    expect(Value.Check(RegisterPushDeviceRequest, { provider: 'webpush', subscription: { ...sub, endpoint: 'http://10.0.0.1/x' }, platform: 'web' })).toBe(false);
    expect(WEB_PUSH_ALLOWED_HOSTS).toContain('fcm.googleapis.com');
    expect(REDACT_KEYS).toEqual(expect.arrayContaining(['expoPushToken', 'p256dh']));
  });

  it('device DTO never carries tokens', () => {
    expect(Object.keys(PushDevice.properties).sort()).toEqual(['createdAt', 'id', 'platform']);
    expect(JSON.stringify(PushDevice)).not.toMatch(/token|endpoint|p256dh/i);
  });

  it('delivery jobs require an organization context', () => {
    const job = { jobVersion: 1, kind: 'deliver_notification', organizationId: ID, userId: ID, notificationId: ID, channel: 'web_push', deliveryKey: `${ID}:web_push` };
    expect(Value.Check(NotificationDeliveryJobPayload, job)).toBe(true);
    const { organizationId: _o, ...noOrg } = job;
    expect(Value.Check(NotificationDeliveryJobPayload, noOrg)).toBe(false);
  });
});
