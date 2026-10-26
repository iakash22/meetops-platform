import { describe, expect, it } from 'vitest';
import {
  formatChangedAt,
  listUnsubscribeHeaders,
  renderAuthMail,
  renderTemplate,
  signEmailLinkToken,
  verifyEmailLinkToken,
} from '../src/index.js';

const SECRET = 'test-only-secret-0123456789abcdef0123456789';
const links = {
  preferencesUrl: 'https://app.test/settings/notifications',
  unsubscribeUrl: 'https://app.test/u?t=abc',
};

describe('product templates', () => {
  it('member-added escapes variables and adds one-click unsubscribe headers', () => {
    const r = renderTemplate('member-added', {
      ...links,
      name: '<b>Ann</b>',
      workspaceName: 'Acme & Co',
      addedBy: '<script>x</script>',
      role: 'admin',
      workspaceUrl: 'https://app.test/w',
    });
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('Acme &amp; Co');
    expect(r.html).toContain('Manage email preferences');
    expect(r.attachments.length).toBeGreaterThan(0);
    expect(r.text).toContain('https://app.test/u?t=abc');
    expect(r.headers).toEqual({
      'List-Unsubscribe': '<https://app.test/u?t=abc>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('member-removed, tasks-ready-for-review, integration-error render', () => {
    expect(
      renderTemplate('member-removed', { ...links, workspaceName: 'W', removedBy: 'Bo' }).text,
    ).toContain('by Bo');
    const t = renderTemplate('tasks-ready-for-review', {
      ...links,
      meetingTitle: 'Sync',
      taskTitles: ['A<', 'B'],
      taskCount: 2,
      reviewUrl: 'https://app.test/r',
    });
    expect(t.subject).toBe('2 tasks ready for review: Sync');
    expect(t.html).toContain('A&lt;');
    const e = renderTemplate('integration-error', {
      preferencesUrl: links.preferencesUrl,
      provider: 'Slack',
      workspaceName: 'W',
      reason: 'token_revoked',
      failingSince: '2026-10-26',
      settingsUrl: 'https://app.test/s',
    });
    expect(e.text).toContain('Reason: token_revoked');
    expect(e.headers).toBeUndefined();
  });

  it('strips header injection from subjects and rejects unsafe unsubscribe URLs', () => {
    const r = renderTemplate('member-removed', {
      ...links,
      workspaceName: 'W\r\nBcc: evil@x.test',
    });
    expect(r.subject).not.toMatch(/[\r\n]/);
    expect(() => listUnsubscribeHeaders('http://app.test/u')).toThrow();
    expect(() => listUnsubscribeHeaders('javascript:alert(1)')).toThrow();
    expect(() =>
      renderTemplate('member-removed', {
        ...links,
        unsubscribeUrl: 'javascript:x',
        workspaceName: 'W',
      }),
    ).toThrow();
  });
});

describe('auth payloads', () => {
  it('uses name, inviter, role and expiresInDays', () => {
    const r = renderAuthMail({
      to: 'a@x.test',
      template: 'invitation',
      data: {
        url: 'https://app.test/i',
        organizationName: 'Acme',
        name: 'Ann',
        inviterName: 'Bo',
        role: 'member',
        expiresInDays: '7',
      },
    });
    expect(r.subject).toBe('Bo invited you to Acme on MeetOps');
    expect(r.text).toContain('member');
    expect(r.text).toContain('expires in 7 days');
  });

  it('lockout states lockedForMinutes', () => {
    const r = renderAuthMail({
      to: 'a@x.test',
      template: 'login_lockout',
      data: { url: 'https://app.test/f', lockedForMinutes: '15' },
    });
    expect(r.text).toContain('for 15 minutes');
  });

  it('password_changed formats changedAt in the user time zone', () => {
    const r = renderAuthMail({
      to: 'a@x.test',
      template: 'password_changed',
      data: {
        url: 'https://app.test/f',
        name: 'Ann',
        changedAt: '2026-10-26T10:00:00.000Z',
        timeZone: 'Asia/Kolkata',
      },
    });
    expect(r.text).toContain('3:30');
    expect(r.text).toContain('Hi Ann');
    expect(formatChangedAt('2026-10-26T10:00:00.000Z', 'Not/AZone')).toContain('10:00');
    expect(() =>
      renderAuthMail({
        to: 'a@x.test',
        template: 'password_changed',
        data: { url: 'https://app.test/f' },
      }),
    ).toThrow();
  });
});

describe('email link tokens', () => {
  const claims = {
    purpose: 'unsubscribe' as const,
    userId: 'u1',
    organizationId: 'o1',
    category: 'member-added',
  };
  const now = new Date('2026-10-26T00:00:00Z');

  it('round-trips and is purpose-bound', () => {
    const t = signEmailLinkToken(SECRET, claims, { ttlSeconds: 60, now });
    expect(verifyEmailLinkToken(SECRET, t, 'unsubscribe', now)).toMatchObject(claims);
    expect(verifyEmailLinkToken(SECRET, t, 'preferences', now)).toBeNull();
  });

  it('rejects expired, tampered and wrong-secret tokens', () => {
    const t = signEmailLinkToken(SECRET, claims, { ttlSeconds: 60, now });
    expect(
      verifyEmailLinkToken(SECRET, t, 'unsubscribe', new Date(now.getTime() + 61_000)),
    ).toBeNull();
    const [body, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims, userId: 'u2', exp: 9e9 })).toString(
      'base64url',
    );
    expect(verifyEmailLinkToken(SECRET, `${forged}.${sig}`, 'unsubscribe', now)).toBeNull();
    expect(verifyEmailLinkToken(`${SECRET}x`, `${body}.${sig}`, 'unsubscribe', now)).toBeNull();
    expect(verifyEmailLinkToken(SECRET, 'garbage', 'unsubscribe', now)).toBeNull();
    expect(() => signEmailLinkToken('short', claims, { ttlSeconds: 60 })).toThrow();
  });
});
