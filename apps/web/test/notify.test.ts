import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/client';
import { ERROR_MESSAGES } from '@/lib/api/error-messages';
import { applyFieldErrors, errorTitle, isNetworkError, toastError } from '@/lib/errors/notify';
import { showToast } from '@/lib/errors/toaster';

vi.mock('@/lib/errors/toaster', () => ({ showToast: vi.fn(), dismissAllToasts: vi.fn() }));

const last = () => {
  const call = vi.mocked(showToast).mock.calls.at(-1);
  return call ? { variant: call[0], title: call[1], ...call[2] } : undefined;
};
const validation = (details: { path: string; message: string }[], status = 400) =>
  ApiError.fromResponse(status, {
    error: { code: 'VALIDATION_FAILED', message: 'server text', details },
  });

describe('errorTitle / isNetworkError', () => {
  it.each([
    [new TypeError('Failed to fetch'), "Can't reach MeetOps right now"],
    [new ApiError(0, 'UNKNOWN', 'csrf unavailable'), "Can't reach MeetOps right now"],
    [new ApiError(502, 'UNKNOWN', 'bad gateway'), "Can't reach MeetOps right now"],
    [new ApiError(403, 'CSRF_INVALID', 'csrf'), 'Session expired, please try again'],
    [new ApiError(401, 'UNAUTHENTICATED', 'no'), 'Your session has ended'],
    [new ApiError(429, 'RATE_LIMITED', 'slow'), 'Too many attempts'],
    [new ApiError(409, 'CONFLICT', 'x'), 'Something went wrong'],
    [new Error('boom'), 'Something went wrong'],
  ])('%s → %s', (err, title) => {
    expect(errorTitle(err)).toBe(title);
  });

  it('a client-side BAD_REQUEST (status 0) is not a network error', () => {
    expect(isNetworkError(new ApiError(0, 'BAD_REQUEST', 'insecure upload'))).toBe(false);
  });
});

describe('toastError', () => {
  beforeEach(() => vi.mocked(showToast).mockClear());

  it('toasts an error with fixed copy, never the server message', () => {
    toastError(new ApiError(429, 'RATE_LIMITED', 'raw server text'));
    expect(last()).toMatchObject({
      variant: 'error',
      title: 'Too many attempts',
      description: ERROR_MESSAGES.RATE_LIMITED,
    });
    expect(JSON.stringify(last())).not.toContain('raw server text');
  });

  it('network errors get a connection hint; titles can be overridden', () => {
    toastError(new TypeError('Failed to fetch'), { title: 'Could not save' });
    expect(last()).toMatchObject({
      title: 'Could not save',
      description: 'Check your connection and try again.',
    });
  });
});

describe('applyFieldErrors', () => {
  it('maps detail paths to fields with the caller copy and focuses the first', () => {
    const setError = vi.fn();
    const err = validation([
      { path: '/email', message: 'invalid' },
      { path: '/password', message: 'too_small' },
      { path: '/unknown', message: 'x' },
    ]);
    expect(applyFieldErrors(setError, err, { email: 'Bad email.', password: '' })).toBe(true);
    expect(setError).toHaveBeenCalledTimes(2);
    expect(setError).toHaveBeenNthCalledWith(
      1,
      'email',
      { type: 'server', message: 'Bad email.' },
      { shouldFocus: true },
    );
    expect(setError).toHaveBeenNthCalledWith(
      2,
      'password',
      { type: 'server', message: "This value isn't valid." },
      { shouldFocus: false },
    );
  });

  it('returns false (caller toasts) for errors without field details', () => {
    const setError = vi.fn();
    expect(applyFieldErrors(setError, new ApiError(500, 'INTERNAL', 'x'), { email: 'x' })).toBe(
      false,
    );
    expect(applyFieldErrors(setError, validation([]), { email: 'x' })).toBe(false);
    expect(
      applyFieldErrors(setError, validation([{ path: '/other', message: 'x' }]), { email: 'x' }),
    ).toBe(false);
    expect(applyFieldErrors(setError, new TypeError('x'), { email: 'x' })).toBe(false);
    expect(setError).not.toHaveBeenCalled();
  });
});

describe('toast variants', () => {
  it('errors stay up for 8s; success and info use the default duration', async () => {
    const { notify } = await import('@/lib/errors/notify');
    vi.mocked(showToast).mockClear();
    notify.error('E', 'd');
    notify.success('S');
    notify.info('I');
    expect(vi.mocked(showToast).mock.calls).toEqual([
      ['error', 'E', { description: 'd', duration: 8000 }],
      ['success', 'S', { description: undefined }],
      ['default', 'I', { description: undefined }],
    ]);
  });
});
