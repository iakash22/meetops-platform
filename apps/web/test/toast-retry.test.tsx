import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toaster, toast, useToastStore } from '@/components/ui/toast';
import { ApiError } from '@/lib/api/client';
import { isRetryableError, toastError } from '@/lib/errors/notify';

afterEach(() => {
  act(() => useToastStore.setState({ toasts: [] }));
});

const last = () => useToastStore.getState().toasts.at(-1);

describe('isRetryableError', () => {
  it.each([
    [new TypeError('Failed to fetch'), true],
    [new ApiError(0, 'UNKNOWN', 'unreachable'), true],
    [new ApiError(500, 'INTERNAL', 'x'), true],
    [new ApiError(503, 'UNKNOWN', 'x'), true],
    [new ApiError(403, 'CSRF_INVALID', 'csrf'), true],
    [new ApiError(0, 'BAD_REQUEST', 'insecure upload'), false],
    [new ApiError(400, 'VALIDATION_FAILED', 'x'), false],
    [new ApiError(401, 'UNAUTHENTICATED', 'x'), false],
    [new ApiError(403, 'FORBIDDEN', 'x'), false],
    [new ApiError(404, 'NOT_FOUND', 'x'), false],
    [new ApiError(409, 'CONFLICT', 'x'), false],
    [new ApiError(429, 'RATE_LIMITED', 'x'), false],
    [new Error('boom'), false],
  ])('%s → %s', (err, expected) => {
    expect(isRetryableError(err)).toBe(expected);
  });
});

describe('toastError onRetry', () => {
  it('adds a Retry action only for retryable errors', () => {
    const onRetry = vi.fn();
    toastError(new ApiError(502, 'UNKNOWN', 'bad gateway'), { onRetry });
    expect(last()?.action).toMatchObject({ label: 'Retry' });
    toastError(new ApiError(404, 'NOT_FOUND', 'gone'), { onRetry });
    expect(last()?.action).toBeUndefined();
    toastError(new ApiError(502, 'UNKNOWN', 'bad gateway'));
    expect(last()?.action).toBeUndefined();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('keeps the 429 countdown toast without a Retry button', () => {
    vi.useFakeTimers();
    try {
      const err = new ApiError(429, 'RATE_LIMITED', 'slow');
      err.retryAfterSeconds = 3;
      toastError(err, { onRetry: vi.fn() });
      expect(last()?.action).toBeUndefined();
      expect(last()?.description).toBe('Try again in 3 seconds.');
    } finally {
      act(() => useToastStore.setState({ toasts: [] }));
      vi.useRealTimers();
    }
  });

  it('renders Retry, dismisses the toast and calls back exactly once', async () => {
    const onRetry = vi.fn();
    render(<Toaster />);
    act(() => toastError(new TypeError('Failed to fetch'), { title: 'Couldn’t save', onRetry }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Check your connection and try again.');
    const retry = within(alert).getByRole('button', { name: 'Retry' });
    retry.focus();
    expect(retry).toHaveFocus();
    await userEvent.dblClick(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText('Couldn’t save')).not.toBeInTheDocument());
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('plain toasts can carry a custom action too', async () => {
    const onClick = vi.fn();
    render(<Toaster />);
    act(() => {
      toast('Meeting archived', { duration: 0, action: { label: 'Undo', onClick } });
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
