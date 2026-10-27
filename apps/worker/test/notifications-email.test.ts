import { describe, expect, it, vi } from 'vitest';
import type { EmailService } from '@meetops/notifications';
import { createNotificationEmailSender } from '../src/notifications/email.js';

const svc: EmailService = {
  provider: 'test',
  send: async () => ({ messageId: 'm', accepted: [], rejected: [], provider: 'test' }),
  verify: async () => true,
};

describe('notification email channel wiring (ADR-014)', () => {
  it('off without WEB_BASE_URL', () => {
    const log = { warn: vi.fn() };
    expect(createNotificationEmailSender({}, log, { emailService: () => svc })).toBeUndefined();
    expect(log.warn).toHaveBeenCalledOnce();
  });
  it('off (no fallback) when the email config or base URL is invalid; logs the error name only', () => {
    const log = { warn: vi.fn() };
    expect(
      createNotificationEmailSender({ WEB_BASE_URL: 'http://app.example.com' }, log, {
        emailService: () => svc,
      }),
    ).toBeUndefined();
    expect(
      createNotificationEmailSender({ WEB_BASE_URL: 'https://app.example.com' }, log, {
        emailService: () => {
          throw new Error('EMAIL_SMTP_PASSWORD=hunter2 missing');
        },
      }),
    ).toBeUndefined();
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('hunter2');
  });
  it('on with https WEB_BASE_URL and an email service; address comes from the lookup', async () => {
    const userEmail = vi.fn(async () => 'u@example.com');
    const s = createNotificationEmailSender(
      { WEB_BASE_URL: 'https://app.example.com' },
      { warn: vi.fn() },
      { emailService: () => svc, userEmail },
    );
    expect(s).toBeDefined();
    const r = await s!.send({
      organizationId: '11111111-1111-4111-8111-111111111111',
      userId: '44444444-4444-4444-8444-000000000001',
      notification: {
        id: '55555555-5555-4555-8555-000000000001',
        type: 'auth.new_location_signin',
        data: { sessionId: '33333333-3333-4333-8333-333333333333', reason: 'new_country' },
      },
    });
    expect(r).toEqual({ status: 'sent', providerMessageId: 'm' });
    expect(userEmail).toHaveBeenCalledWith('44444444-4444-4444-8444-000000000001');
  });
});
