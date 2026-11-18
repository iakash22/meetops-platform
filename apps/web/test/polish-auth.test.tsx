import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toaster, useToastStore } from '@/components/ui/toast';
import { LegalLine } from '@/features/auth/auth-layout';
import { ApiError, parseRetryAfter } from '@/lib/api/client';
import { toastError } from '@/lib/errors/notify';

afterEach(() => {
  act(() => useToastStore.setState({ toasts: [] }));
  vi.useRealTimers();
});

describe('parseRetryAfter', () => {
  it.each([
    [null, undefined],
    ['', undefined],
    ['0', undefined],
    ['12', 12],
    ['99999', 3600],
    ['soon', undefined],
  ])('%s → %s', (v, out) => expect(parseRetryAfter(v)).toBe(out));

  it('accepts an HTTP date', () => {
    const now = Date.parse('2026-10-26T10:00:00Z');
    expect(parseRetryAfter('Mon, 26 Oct 2026 10:00:30 GMT', now)).toBe(30);
  });
});

describe('Retry-After countdown toast', () => {
  it('counts down in place and then says you can retry', () => {
    vi.useFakeTimers();
    const err = new ApiError(429, 'RATE_LIMITED', 'server text');
    err.retryAfterSeconds = 3;
    act(() => toastError(err));
    const last = () => useToastStore.getState().toasts.at(-1);
    expect(last()).toMatchObject({
      title: 'Too many attempts',
      description: 'Try again in 3 seconds.',
    });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(last()?.description).toBe('Try again in 1 second.');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(last()?.description).toBe('You can try again now.');
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it('renders the toast through Sonner with role=alert', async () => {
    render(<Toaster />);
    act(() => toastError(new ApiError(500, 'UNKNOWN', 'x')));
    expect(await screen.findByRole('alert')).toHaveTextContent("Can't reach MeetOps right now");
  });
});

describe('LegalLine', () => {
  it('renders nothing when neither URL is configured', () => {
    const { container } = render(<LegalLine termsUrl={undefined} privacyUrl={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('renders the privacy link even when the terms URL is missing', () => {
    render(<LegalLine termsUrl={undefined} privacyUrl="https://x.test/privacy" />);
    expect(screen.queryByRole('link', { name: /Terms of Service/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Privacy Policy/ })).toHaveAttribute(
      'href',
      'https://x.test/privacy',
    );
  });
  it('renders the terms link even when the privacy URL is missing', () => {
    render(<LegalLine termsUrl="https://x.test/terms" privacyUrl={undefined} />);
    expect(screen.getByRole('link', { name: /Terms of Service/ })).toHaveAttribute(
      'href',
      'https://x.test/terms',
    );
    expect(screen.queryByRole('link', { name: /Privacy Policy/ })).not.toBeInTheDocument();
  });
  it('rejects an unsafe terms URL but still shows a safe privacy link', () => {
    render(<LegalLine termsUrl="javascript:alert(1)" privacyUrl="/privacy" />);
    expect(screen.queryByRole('link', { name: /Terms of Service/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Privacy Policy/ })).toHaveAttribute(
      'href',
      '/privacy',
    );
  });
  it('links Terms and Privacy when both are configured', () => {
    render(<LegalLine termsUrl="/legal/terms" privacyUrl="https://x.test/privacy" />);
    expect(screen.getByRole('link', { name: /Terms of Service/ })).toHaveAttribute(
      'href',
      '/legal/terms',
    );
    expect(screen.getByRole('link', { name: /Privacy Policy/ })).toHaveAttribute(
      'href',
      'https://x.test/privacy',
    );
  });
});
