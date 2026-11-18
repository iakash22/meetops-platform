import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OptionsApp } from '../entrypoints/options/OptionsApp';
import { PopupFrame } from '../entrypoints/popup/PopupView';
import { PrivacyPolicyLink } from '../src/lib/privacy-link';

describe('PrivacyPolicyLink', () => {
  it('renders nothing when the URL is missing', () => {
    expect(
      renderToStaticMarkup(<PrivacyPolicyLink url={undefined} webOrigin="https://app.x" />),
    ).toBe('');
  });

  it('opens a safe URL in a new tab and stays in the accessibility tree', () => {
    const html = renderToStaticMarkup(
      <PrivacyPolicyLink url="https://x.test/privacy" webOrigin="https://app.meetops.ai" />,
    );
    expect(html).toContain('href="https://x.test/privacy"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('Privacy Policy');
    expect(html).toContain('opens in a new tab');
    expect(html).not.toContain('aria-hidden');
  });

  it('resolves a path against the web origin', () => {
    const html = renderToStaticMarkup(
      <PrivacyPolicyLink url="/privacy" webOrigin="https://app.meetops.ai" />,
    );
    expect(html).toContain('href="https://app.meetops.ai/privacy"');
  });
});

describe('popup footer privacy link', () => {
  it('can sit in the popup frame and remains a real link', () => {
    const html = renderToStaticMarkup(
      <PopupFrame>
        <PrivacyPolicyLink url="https://x.test/privacy" webOrigin="https://app.meetops.ai" />
      </PopupFrame>,
    );
    expect(html).toContain('mo-popup');
    expect(html).toContain('href="https://x.test/privacy"');
    expect(html).toContain('mo-privacy-link');
  });
});

describe('options page', () => {
  it('shows the privacy-policy link when a URL is configured', () => {
    const html = renderToStaticMarkup(
      <OptionsApp privacyUrl="https://x.test/privacy" webOrigin="https://app.meetops.ai" />,
    );
    expect(html).toContain('MeetOps AI');
    expect(html).toContain('href="https://x.test/privacy"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('Privacy Policy');
  });

  it('stays usable when the privacy URL is not configured', () => {
    const html = renderToStaticMarkup(<OptionsApp privacyUrl={undefined} />);
    expect(html).toContain('MeetOps AI');
    expect(html).not.toContain('Privacy Policy');
  });
});
