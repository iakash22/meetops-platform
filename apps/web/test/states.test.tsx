import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EmptyState, ErrorState, LoadingState } from '@/components/states/states';

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
    render(<ErrorState error={new Error('boom')} onRetry={onRetry} />);
    expect(screen.getByTestId('error-state')).toHaveTextContent('boom');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
