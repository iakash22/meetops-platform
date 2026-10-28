import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CONSENT_CONFIRMATION, CONSENT_NOTICE, setConfirmed } from '../src/lib/consent.js';
import { MAX_DURATION_MS } from '../src/lib/contract-limits.js';
import {
  MEETING_RESOLVE_MESSAGE,
  OFFLINE_MESSAGE,
  OPEN_FROM_TOOLBAR,
  UNSUPPORTED_PAGE_MESSAGE,
  RELOADED_MESSAGE,
  POPUP_ONLY_ERROR,
  detectPopupContext,
  popupErrorMessage,
} from '../entrypoints/popup/popup-errors.js';
import {
  OpenFromToolbar,
  PopupView,
  pillFor,
  type PopupViewProps,
} from '../entrypoints/popup/PopupView.js';

const noop = () => undefined;
const base: PopupViewProps = {
  auth: { state: 'unpaired' },
  status: { status: 'idle' },
  consent: { status: 'unconfirmed' },
  now: 0,
  error: '',
  onPair: noop,
  onUnpair: noop,
  onConsentChange: noop,
  onRecord: noop,
  onStop: noop,
  onDismissWarning: noop,
};
const render = (p: Partial<PopupViewProps> = {}) =>
  renderToStaticMarkup(<PopupView {...base} {...p} />);

/** Text of the first <button> whose class list contains `variant`. */
const buttonsOf = (html: string, variant: string) =>
  [...html.matchAll(/<button[^>]*class="([^"]*)"[^>]*>([^<]*)<\/button>/g)]
    .filter((m) => m[1]?.split(' ').includes(`mo-btn--${variant}`))
    .map((m) => m[2]);

describe('popup header', () => {
  it('renders the logo mark, wordmark and a full-width divider', () => {
    const html = render();
    expect(html).toContain('class="mo-logo"');
    expect(html).toMatch(/<h1 class="mo-wordmark">MeetOps <span[^>]*>AI<\/span><\/h1>/);
    expect(html).toContain('<hr class="mo-divider"/>');
    expect(html).toMatch(/^<main class="mo-popup">/);
  });

  it.each([
    [undefined, 'Checking…', 'muted'],
    [{ state: 'unpaired' } as const, 'Not paired', 'muted'],
    [{ state: 'pairing' } as const, 'Pairing…', 'pending'],
    [{ state: 'paired' } as const, 'Paired', 'paired'],
    [{ state: 'repair_required', reason: 'expired' } as const, 'Pair again', 'warning'],
  ])('status pill for %j', (auth, label, tone) => {
    expect(pillFor(auth)).toEqual({ label, tone });
    const html = render({ auth });
    expect(html).toContain(`mo-pill mo-pill--${tone}`);
    expect(html).toContain(`aria-label="Pairing: ${label}"`);
  });
});

describe('popup render states', () => {
  it('not paired: primary Pair with MeetOps, secondary Record this meeting', () => {
    const html = render();
    expect(buttonsOf(html, 'primary')).toEqual(['Pair with MeetOps']);
    expect(buttonsOf(html, 'secondary')).toEqual(['Record this meeting']);
  });

  it('paired: Unpair is low emphasis and Record this meeting becomes primary', () => {
    const html = render({ auth: { state: 'paired' } });
    expect(html).toContain('Paired with your organization.');
    expect(buttonsOf(html, 'ghost')).toEqual(['Unpair']);
    expect(buttonsOf(html, 'primary')).toEqual(['Record this meeting']);
  });

  it('pairing in progress offers a restart', () => {
    const html = render({ auth: { state: 'pairing' } });
    expect(html).toContain('Confirm the pairing in the MeetOps tab that just opened.');
    expect(buttonsOf(html, 'secondary')).toContain('Restart pairing');
  });

  it('re-pair required explains why', () => {
    const html = render({ auth: { state: 'repair_required', reason: 'org_switch' } });
    expect(html).toContain('You switched organization. Pair again to continue.');
    expect(buttonsOf(html, 'primary')).toEqual(['Pair again']);
  });

  it('hides pairing controls until the first status reply', () => {
    const html = render({ auth: undefined });
    expect(html).not.toContain('Pair with MeetOps');
    expect(html).toContain('Record this meeting');
  });

  it('consent gate: notice and an unticked confirmation keep Record disabled', () => {
    const html = render();
    expect(html).toContain('Recording consent');
    expect(html).toContain(CONSENT_NOTICE.replaceAll("'", '&#x27;'));
    expect(html).toContain(CONSENT_CONFIRMATION);
    expect(html).toMatch(/<input[^>]*type="checkbox"/);
    expect(html).not.toMatch(/<input[^>]*checked/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Record this meeting/);
    expect(html).toContain('Tick the box above to enable recording');
    expect(html).not.toContain('Start recording');
  });

  it('consent gate: ticking the confirmation enables Record this meeting', () => {
    const html = render({ consent: setConfirmed(true, 1), auth: { state: 'paired' } });
    expect(html).toMatch(/<input[^>]*checked/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Record this meeting/);
    expect(buttonsOf(html, 'primary')).toEqual(['Record this meeting']);
    expect(html).not.toContain('Tick the box above');
  });

  it('consent gate: Record stays disabled while a start is in flight', () => {
    expect(render({ consent: setConfirmed(true, 1), starting: true })).toMatch(
      /<button[^>]*disabled=""[^>]*>Record this meeting/,
    );
  });

  it('recording shows the rose live dot, elapsed time and Stop', () => {
    const html = render({ status: { status: 'recording', startedAt: 0, chunks: 3 }, now: 65_000 });
    expect(html).toContain('class="mo-live-dot"');
    expect(html).toContain('1:05');
    expect(html).toContain('· 3 chunks');
    expect(buttonsOf(html, 'secondary')).toEqual(['Stop recording']);
  });

  it('stopping disables Stop', () => {
    expect(render({ status: { status: 'stopping' } })).toMatch(
      /<button[^>]*disabled=""[^>]*>Stop recording/,
    );
  });

  it('recording error renders an error callout, not the rose accent', () => {
    const html = render({ status: { status: 'error', lastError: 'Mic gone' } });
    expect(html).toContain('mo-callout--error');
    expect(html).toContain('Mic gone');
    expect(html).not.toContain('mo-live-dot');
  });

  it('storage warning and incomplete callouts', () => {
    const html = render({
      status: { status: 'idle', storageWarning: 'Low space', incomplete: true },
    });
    expect(html).toContain('aria-label="Storage warning"');
    expect(html).toContain('aria-label="Incomplete recording"');
  });

  it('non-field errors render as a toast; none when empty', () => {
    expect(render()).not.toContain('mo-toast');
    expect(render({ error: 'No active tab' })).toContain(
      '<div class="mo-toast" role="alert">No active tab</div>',
    );
  });
});

describe('popup UI pass: status, re-auth, a11y', () => {
  it('re-auth required: warning alert, never the error/rose styles, keeps queued recordings', () => {
    const html = render({ auth: { state: 'repair_required', reason: 'refresh_rejected' } });
    expect(html).toMatch(
      /class="mo-callout mo-callout--warning" role="alert" aria-label="Sign-in required"/,
    );
    expect(html).toContain('Your sign-in was revoked. Pair again to continue.');
    expect(html).toContain('stay queued and upload after you pair again');
    expect(html).not.toContain('mo-callout--error');
  });

  it('re-auth required without a reason still explains', () => {
    expect(render({ auth: { state: 'repair_required' } })).toContain(
      'Your sign-in needs to be renewed. Pair again to continue.',
    );
  });

  it('not paired: hint that recordings stay on the device; hidden when paired or unknown', () => {
    const hint = 'recordings are kept on this device';
    expect(render()).toContain(hint);
    expect(render({ auth: { state: 'paired' } })).not.toContain(hint);
    expect(render({ auth: undefined })).not.toContain(hint);
  });

  it('confirmed consent is announced as per-meeting', () => {
    const html = render({ consent: setConfirmed(true, 1) });
    expect(html).toContain('Consent confirmed for this meeting only.');
    expect(html).toMatch(/<p class="mo-consent__ok" role="status">/);
  });

  it('recording: polite status, non-live timer and the 4 h auto-stop countdown', () => {
    const html = render({
      status: { status: 'recording', startedAt: 0, chunks: 1 },
      now: MAX_DURATION_MS - 60_000,
    });
    expect(html).toMatch(/<span class="mo-live__state" role="status">Recording<\/span>/);
    expect(html).toMatch(/role="timer" aria-label="Elapsed">3:59:00</);
    expect(html).toContain('Stops automatically in <span class="mo-mono">1:00</span>');
  });

  it.each([
    ['starting', 'Starting…'],
    ['stopping', 'Saving…'],
  ] as const)('%s shows a spinner and a clear label', (status, label) => {
    const html = render({ status: { status } });
    expect(html).toContain('mo-spinner');
    expect(html).toContain(`>${label}</span>`);
    expect(html).not.toContain('mo-live-dot');
  });

  it('maps network and reloaded-extension errors to friendly copy', () => {
    expect(popupErrorMessage('Pairing error: Failed to fetch', true)).toBe(OFFLINE_MESSAGE);
    expect(
      popupErrorMessage('Could not establish connection. Receiving end does not exist.', true),
    ).toBe(RELOADED_MESSAGE);
  });

  it('maps meeting-resolve failures without showing raw status text', () => {
    expect(popupErrorMessage('Meeting resolve failed: HTTP 0 UNSUPPORTED_PAGE', true)).toBe(
      UNSUPPORTED_PAGE_MESSAGE,
    );
    expect(popupErrorMessage('Meeting resolve failed: HTTP 403 FORBIDDEN', true)).toBe(
      MEETING_RESOLVE_MESSAGE,
    );
  });
});

describe('popup-only sender error', () => {
  it('is never shown inside the real popup', () => {
    expect(popupErrorMessage(POPUP_ONLY_ERROR, true)).toBe('');
    expect(popupErrorMessage(`Pairing error: ${POPUP_ONLY_ERROR}`, true)).toBe('');
    const html = render({ error: popupErrorMessage(POPUP_ONLY_ERROR, true) });
    expect(html).not.toContain(POPUP_ONLY_ERROR);
    expect(html).not.toContain('mo-toast');
  });

  it('becomes a friendly hint outside the popup', () => {
    expect(popupErrorMessage(POPUP_ONLY_ERROR, false)).toBe(OPEN_FROM_TOOLBAR);
    const html = renderToStaticMarkup(<OpenFromToolbar />);
    expect(html).toContain('MeetOps works from the toolbar.');
    expect(html).not.toContain(POPUP_ONLY_ERROR);
    expect(html).not.toContain('<button');
  });

  it('passes other errors through unchanged', () => {
    expect(popupErrorMessage('No active tab', true)).toBe('No active tab');
    expect(popupErrorMessage(undefined, true)).toBe('');
  });

  it('detects the popup (no tab) vs popup.html opened as a tab', async () => {
    await expect(detectPopupContext(() => Promise.resolve(undefined))).resolves.toBe('popup');
    await expect(detectPopupContext(() => Promise.resolve({ id: 7 }))).resolves.toBe('tab');
    await expect(detectPopupContext(() => Promise.reject(new Error('x')))).resolves.toBe('popup');
  });
});

describe('popup stylesheet', () => {
  const css = readFileSync(new URL('../entrypoints/popup/theme.css', import.meta.url), 'utf8');

  it('uses the brand tokens', () => {
    for (const token of [
      '--mo-background: #0a0a0a',
      '--mo-foreground: #f5f5f7',
      '--mo-surface-1: #141416',
      '--mo-border: #2a2a2e',
      '--mo-primary: #007ba7',
      '--mo-primary-foreground: #ffffff',
      '--mo-ring: #3ab0e0',
      '--mo-highlight: #ff2d95',
      '--mo-destructive-text: #f87171',
      '--mo-muted-foreground: #a1a1aa',
      '--mo-radius: 12px',
    ])
      expect(css).toContain(token);
  });

  it('is 380px wide with an edge-to-edge divider, focus rings and reduced motion', () => {
    expect(css).toMatch(/\.mo-popup \{[^}]*width: 380px;[^}]*padding: 0;/);
    expect(css).toMatch(/\.mo-divider \{[^}]*width: 100%;[^}]*margin: 0;/);
    expect(css).toMatch(/\.mo-btn:focus-visible \{[^}]*outline: 2px solid var\(--mo-ring\)/);
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('only animates under prefers-reduced-motion: no-preference', () => {
    const [before, motionSafe = ''] = css.split('@media (prefers-reduced-motion: no-preference)');
    expect(before).not.toMatch(/animation:\s*mo-/);
    expect(motionSafe).toMatch(/animation:\s*mo-pulse/);
  });

  it('buttons and the consent checkbox row are at least 44px tall', () => {
    expect(css).toMatch(/\.mo-btn \{[^}]*min-height: 44px;/);
    expect(css).toMatch(/\.mo-btn--ghost \{[^}]*min-height: 44px;/);
    expect(css).toMatch(/\.mo-consent__check \{[^}]*min-height: 44px;/);
  });

  it('never uses the rose accent for errors', () => {
    const errorRules = css.match(/\.mo-(toast|callout--error)[^{]*\{[^}]*\}/g) ?? [];
    expect(errorRules.length).toBeGreaterThan(0);
    for (const rule of errorRules) expect(rule).not.toMatch(/highlight|ff2d95/i);
  });
});
