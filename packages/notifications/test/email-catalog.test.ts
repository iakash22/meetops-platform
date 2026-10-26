import { describe, expect, it } from 'vitest';
import {
  AUTH_EMAILS,
  contrastRatio,
  emailNames,
  emailTheme,
  messagesFor,
  renderEmail,
  type EmailName,
} from '../src/index.js';
import { sampleVariables } from './fixtures.js';

const render = <K extends EmailName>(n: K) => renderEmail(n, sampleVariables[n]);

const withoutLogo = (h: string) => h.replace(/<img src="cid:meetops-logo@meetops"[^>]*>/g, '');

describe('email catalog', () => {
  it('covers every product email', () => {
    expect([...emailNames].sort()).toEqual(
      [
        'account-exists',
        'integration-error',
        'invitation',
        'login-lockout',
        'meeting-summary',
        'member-added',
        'member-removed',
        'password-changed',
        'password-reset',
        'task-assigned',
        'tasks-ready-for-review',
        'verification',
      ].sort(),
    );
  });

  for (const name of emailNames) {
    describe(name, () => {
      const r = render(name);
      it('matches html and text snapshots', () => {
        expect(r.subject).toMatchSnapshot('subject');
        expect(r.html).toMatchSnapshot('html');
        expect(r.text).toMatchSnapshot('text');
      });
      it('is email-client safe', () => {
        expect(r.html).toMatch(/^<!doctype html>/);
        expect(r.html).toContain('role="presentation"');
        expect(withoutLogo(r.html)).not.toMatch(/<script|<link|<img|<iframe|<form|javascript:/i);
        // The only image is the CID logo, shipped as an inline attachment (no remote fetch).
        expect(r.html.match(/<img /g)).toHaveLength(2);
        expect(r.html).not.toMatch(/<img [^>]*src="(?!cid:meetops-logo@meetops")/);
        expect(r.html).toContain('alt="MeetOps AI"');
        expect(r.attachments).toEqual([
          expect.objectContaining({
            cid: 'meetops-logo@meetops',
            contentType: 'image/png',
            encoding: 'base64',
          }),
        ]);
        expect(r.html).not.toMatch(/url\(/i);
        expect(r.html).toContain('display:none;max-height:0'); // hidden preheader
        expect(r.html).toContain('background-color:#0A0A0A');
        expect(r.html).toContain('prefers-color-scheme: light');
        expect(r.text.length).toBeGreaterThan(20);
        expect(r.text).not.toMatch(/<[a-z]/i);
      });
      it('uses cerulean only as a fill and links in #3AB0E0', () => {
        expect(r.html).not.toMatch(/(?<!-)color:#007BA7/i);
        for (const m of r.html.matchAll(/<a [^>]*style="([^"]*)"/g)) {
          const style = m[1] ?? '';
          expect(style).toMatch(/color:#(3AB0E0|FFFFFF)/);
        }
      });
      it(
        AUTH_EMAILS.includes(name as never)
          ? 'has no unsubscribe link (security mail)'
          : 'has a preferences and unsubscribe link',
        () => {
          if (AUTH_EMAILS.includes(name as never)) {
            expect(r.html).not.toContain('Manage email preferences');
          } else {
            expect(r.html).toContain('https://app.meetops.test/settings/notifications');
            expect(r.text).toContain(
              'Manage email preferences: https://app.meetops.test/settings/notifications',
            );
            expect(r.text).toContain('Unsubscribe: ');
          }
        },
      );
    });
  }
});

describe('escaping', () => {
  const evil = '<img src=x onerror=alert(1)>"\'&';
  it('escapes user data in every string field of every template', () => {
    for (const name of emailNames) {
      const v = structuredClone(sampleVariables[name]) as Record<string, unknown>;
      let injected = false;
      for (const [k, val] of Object.entries(v)) {
        if (typeof val === 'string' && !/Url$/.test(k) && k !== 'locale') {
          v[k] = evil;
          injected = true;
        }
        if (Array.isArray(val))
          v[k] = val.map((x: unknown) =>
            typeof x === 'string' ? evil : { ...(x as object), title: evil, owner: evil },
          );
      }
      const r = renderEmail(name, v as never);
      expect(withoutLogo(r.html), name).not.toContain('<img');
      expect(r.html, name).not.toContain('onerror=alert(1)>');
      if (injected)
        expect(r.html, name).toContain('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;');
    }
  });
  it('escapes link query strings and rejects non-http urls', () => {
    const r = renderEmail('verification', {
      verificationUrl: 'https://a.test/v?a=1&b="x"',
      expiresInHours: 1,
    });
    expect(r.html).toContain('href="https://a.test/v?a=1&amp;b=%22x%22"');
    expect(() =>
      renderEmail('task-assigned', { taskTitle: 't', taskUrl: 'javascript:alert(1)' }),
    ).toThrow();
    expect(() =>
      renderEmail('member-removed', { workspaceName: 'w', preferencesUrl: 'data:text/html,x' }),
    ).toThrow();
  });
  it('strips CR/LF from subjects', () => {
    const r = renderEmail('integration-error', {
      ...sampleVariables['integration-error'],
      provider: 'Jira\r\nBcc: x@y.z',
    });
    expect(r.subject).not.toMatch(/[\r\n]/);
  });
});

describe('localisation', () => {
  it('falls back to English for unknown locales', () => {
    expect(messagesFor('xx')).toBe(messagesFor('en'));
    const r = renderEmail('verification', { ...sampleVariables.verification, locale: 'xx' });
    expect(r.html).toContain('<html lang="en"');
  });
  it('pluralises', () => {
    expect(
      renderEmail('tasks-ready-for-review', {
        ...sampleVariables['tasks-ready-for-review'],
        taskTitles: ['One'],
      }).subject,
    ).toContain('1 task ready');
    expect(render('tasks-ready-for-review').text).toContain('…and 1 more');
  });
  it('greets without a name', () => {
    expect(render('account-exists').text).toContain('Hi there,');
  });
});

describe('theme contrast (WCAG AA)', () => {
  const t = emailTheme;
  it.each([
    ['text on background', t.text, t.background],
    ['text on surface', t.text, t.surface],
    ['muted on surface', t.muted, t.surface],
    ['muted on background', t.muted, t.background],
    ['link on surface', t.link, t.surface],
    ['link on background', t.link, t.background],
    ['link on raised surface', t.link, t.surfaceRaised],
    ['text on raised surface', t.text, t.surfaceRaised],
    ['muted on raised surface', t.muted, t.surfaceRaised],
    ['link chip on cerulean tint', t.link, t.primaryTint],
    ['text on destructive tint', t.text, t.destructiveTint],
    ['button label on cerulean', t.onPrimary, t.primaryFill],
    ['light text', t.light.text, t.light.background],
    ['light muted on surface', t.light.muted, t.light.surface],
    ['light link on surface', t.light.link, t.light.surface],
  ])('%s', (_n, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
  it('cerulean fails as text on black (why it is fill-only)', () => {
    expect(contrastRatio(t.primaryFill, t.background)).toBeLessThan(4.5);
  });
});
