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

/** The only images allowed: the logo (header + footer) and the animated banner, all inline CID. */
const ALLOWED_IMG = /<img src="cid:meetops-(logo|banner)@meetops"[^>]*>/g;
const withoutLogo = (h: string) => h.replace(ALLOWED_IMG, '');

describe('email catalog', () => {
  it('covers every product email', () => {
    expect([...emailNames].sort()).toEqual(
      [
        'account-exists',
        'account-linked',
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
        // Only expected images: the CID logo (header + footer) and one category banner, as inline attachments.
        expect(r.html.match(/<img /g)).toHaveLength(3);
        expect(r.html.match(ALLOWED_IMG)).toHaveLength(3);
        expect(r.html).toMatch(
          /<img src="cid:meetops-banner@meetops"[^>]*alt="Animated MeetOps AI [^"]+"/,
        );
        expect(r.html).toContain('alt="MeetOps AI"');
        expect(r.attachments).toEqual([
          expect.objectContaining({
            cid: 'meetops-logo@meetops',
            contentType: 'image/png',
            encoding: 'base64',
          }),
          expect.objectContaining({
            cid: 'meetops-banner@meetops',
            contentType: 'image/gif',
          }),
        ]);
        // Every cid: referenced in the HTML has a matching attachment, and each image stays small.
        for (const [, cid] of r.html.matchAll(/src="cid:([^"]+)"/g))
          expect(r.attachments.map((a) => a.cid)).toContain(cid);
        for (const a of r.attachments)
          expect(Buffer.from(a.content, 'base64').length).toBeLessThan(200_000);
        expect(r.html).not.toMatch(/url\(/i);
        expect(r.html).toContain('display:none;max-height:0'); // hidden preheader
        expect(r.html).toContain('background-color:#0A0A0A');
        expect(r.html).toContain('prefers-color-scheme: light');
        expect(r.text.length).toBeGreaterThan(20);
        expect(r.text).not.toMatch(/<[a-z]/i);
      });
      it('uses cerulean only as a fill and links in #3AB0E0', () => {
        expect(r.html).not.toMatch(/(?<!-)color:#007BA7/i);
        // Rose is an accent fill only, never text.
        expect(r.html).not.toMatch(/(?<!-)color:#FF2D95/i);
        expect(r.html).toContain('background-color:#FF2D95');
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
    ['text on rose (onHighlight)', t.onHighlight, t.highlight],
    ['hero heading on VML gradient end', t.text, t.primaryTint],
    ['hero labels on VML gradient end', t.muted, t.primaryTint],
    ['hero chip on VML gradient end', t.link, t.primaryTint],
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

describe('image-free build (Outlook desktop / images blocked)', () => {
  /** What a client renders with zero images: drop the non-mso GIF block and every <img>. */
  const noImages = (html: string) =>
    html
      .replace(/<!--\[if !mso\]><!-->[\s\S]*?<!--<!\[endif\]-->/g, '')
      .replace(/<img\b[^>]*>/g, '');
  const text = (html: string) =>
    noImages(html)
      .replace(/<!--\[if [^\]]*\]>|<!\[endif\]-->/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&middot;/g, '·')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ');

  for (const name of emailNames) {
    const r = render(name);
    it(`${name}: banner and all key copy are live text without images`, () => {
      const out = text(r.html);
      expect(out).toMatch(/MeetOps\s*AI/); // wordmark is live text
      for (const f of ['Record', 'Transcribe', 'AI summary', 'Tasks', 'Sync'])
        expect(out).toContain(f);
      const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(r.html)?.[1] ?? '';
      expect(h1.length).toBeGreaterThan(0);
      expect(out).toContain(text(h1).trim());
      expect(noImages(r.html)).not.toContain('cid:meetops-banner');
    });
    it(`${name}: hero is the first thing in the email and carries logo, chip and heading`, () => {
      const body = r.html.slice(r.html.indexOf('<body'));
      const hero = body.indexOf('<v:rect');
      expect(hero).toBeGreaterThan(0);
      // nothing visible (logo, text) before the hero; preheader is hidden
      const before = body.slice(0, hero).replace(/<div style="display:none[\s\S]*?<\/div>/, '');
      expect(before).not.toMatch(/<img|MeetOps/);
      const heroHtml = body.slice(hero, body.indexOf('</v:rect>'));
      expect(heroHtml).toContain('cid:meetops-logo@meetops');
      expect(heroHtml).toMatch(/<h1\b/);
      expect(heroHtml).toContain('background-color:#FF2D95');
      expect((r.html.match(/<h1\b/g) ?? []).length).toBe(1);
    });
    it(`${name}: Outlook gets VML + table icons, modern clients get the GIF`, () => {
      expect(r.html).toMatch(/<!--\[if gte mso 9\]><v:rect[^>]*><v:fill type="gradient"/);
      expect(r.html).toMatch(/<!--\[if mso\]><table[\s\S]*?&#10022;[\s\S]*?<!\[endif\]-->/);
      expect(r.html).toMatch(
        /<!--\[if !mso\]><!--><img src="cid:meetops-banner@meetops" width="600" height="76"/,
      );
    });
  }
});
