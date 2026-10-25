import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConsentSection } from '../entrypoints/popup/ConsentSection.js';
import { CONSENT_CONFIRMATION, initialConsent, setConfirmed } from '../src/lib/consent.js';

const render = (consent = initialConsent(), busy = false) =>
  renderToStaticMarkup(
    createElement(ConsentSection, {
      consent,
      busy,
      onConfirmedChange: () => undefined,
      onRecord: () => undefined,
    }),
  );

const recordButton = (html: string) => /<button[^>]*>Record this meeting<\/button>/.exec(html)?.[0];

describe('popup consent gate', () => {
  it('shows the notice and an unticked confirmation, with Record disabled', () => {
    const html = render();
    expect(html).toContain('Recording consent');
    expect(html).toContain(CONSENT_CONFIRMATION);
    expect(html).toMatch(/<input[^>]*type="checkbox"/);
    expect(html).not.toMatch(/<input[^>]*checked/);
    expect(recordButton(html)).toContain('disabled');
    expect(html).toContain('Tick the box above to enable recording');
  });

  it('enables Record once the user has ticked the confirmation', () => {
    const html = render(setConfirmed(true, 1));
    expect(html).toMatch(/<input[^>]*checked/);
    expect(recordButton(html)).not.toContain('disabled');
    expect(html).not.toContain('Tick the box above');
  });

  it('keeps Record disabled while a start is in flight', () => {
    expect(recordButton(render(setConfirmed(true, 1), true))).toContain('disabled');
  });
});
