import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EmptyState, ErrorState, LoadingState } from '@/components/states/states';
import { ApiError } from '@/lib/api/client';
import { ERROR_MESSAGES } from '@/lib/api/error-messages';

describe('state components', () => {
  it('renders empty state with title and description', () => {
    render(<EmptyState title="No meetings" description="Add one" />);
    expect(screen.getByTestId('empty-state')).toHaveTextContent('No meetings');
    expect(screen.getByText('Add one')).toBeInTheDocument();
  });

  it('renders loading state as busy status', () => {
    render(<LoadingState label="Fetching" />);
    expect(screen.getByTestId('loading-state')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Fetching')).toBeInTheDocument();
  });

  it('renders error message and retries', async () => {
    const onRetry = vi.fn();
    render(<ErrorState error={new Error('boom: GET /secret')} onRetry={onRetry} />);
    expect(screen.getByTestId('error-state')).toHaveTextContent(ERROR_MESSAGES.UNKNOWN);
    expect(screen.getByTestId('error-state')).not.toHaveTextContent('/secret');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('maps api error codes to fixed text and shows the request id, never server details', () => {
    const err = new ApiError(429, 'RATE_LIMITED', 'raw server text POST /auth/login', 'req_123');
    render(<ErrorState error={err} />);
    const el = screen.getByTestId('error-state');
    expect(el).toHaveTextContent(ERROR_MESSAGES.RATE_LIMITED);
    expect(screen.getByTestId('request-id')).toHaveTextContent('req_123');
    expect(el).not.toHaveTextContent('raw server text');
    expect(el).not.toHaveTextContent('/auth/login');
  });
});
