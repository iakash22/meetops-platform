import { describe, expect, it } from 'vitest';
import {
  PushTargetRejectedError,
  assertDeliverableWebPushEndpoint,
  assertExpoPushToken,
  assertWebPushEndpoint,
  buildPushPayload,
  pushTokenFromRegistration,
} from '../src/index.js';

const keys = { p256dh: 'B'.repeat(20), auth: 'a'.repeat(10) };

describe('push target validation (security review C, finding 1)', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QAbc',
  ])('accepts allowlisted %s', (u) => expect(assertWebPushEndpoint(u).hostname).toBeTruthy());

  it.each([
    'http://fcm.googleapis.com/x',
    'https://evil.example/x',
    'https://fcm.googleapis.com.evil.example/x',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/x',
    'https://fcm.googleapis.com:8443/x',
    'https://user:pw@fcm.googleapis.com/x',
    'not a url',
  ])('rejects %s', (u) => expect(() => assertWebPushEndpoint(u)).toThrow(PushTargetRejectedError));

  it('rejects allowlisted hosts that resolve to private addresses (ADR-009 guard)', async () => {
    await expect(
      assertDeliverableWebPushEndpoint('https://fcm.googleapis.com/x', async () => [{ address: '10.0.0.5', family: 4 }]),
    ).rejects.toThrow(PushTargetRejectedError);
    const ok = await assertDeliverableWebPushEndpoint('https://fcm.googleapis.com/x', async () => [
      { address: '142.250.0.1', family: 4 },
    ]);
    expect(ok.pinned?.address).toBe('142.250.0.1');
  });

  it('validates Expo tokens', () => {
    expect(() => assertExpoPushToken('ExponentPushToken[abcdefghijkl]')).not.toThrow();
    expect(() => assertExpoPushToken('https://exp.host/evil')).toThrow(PushTargetRejectedError);
  });

  it('turns registrations into the stored token and never echoes it in errors', () => {
    expect(JSON.parse(pushTokenFromRegistration({ platform: 'web', subscription: { endpoint: 'https://fcm.googleapis.com/x', keys } })).endpoint).toBe('https://fcm.googleapis.com/x');
    try {
      pushTokenFromRegistration({ platform: 'web', subscription: { endpoint: 'https://secret-host.example/abc', keys } });
      expect.fail('should throw');
    } catch (e) {
      expect((e as Error).message).not.toContain('secret-host');
    }
  });

  it('push payloads are generic and ids-only (finding 3)', () => {
    const p = buildPushPayload('00000000-0000-4000-8000-000000000001');
    expect(p).toEqual({ title: 'MeetOps', body: 'You have a new notification', data: { notificationId: '00000000-0000-4000-8000-000000000001' } });
  });
});
