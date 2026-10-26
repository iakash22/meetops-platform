import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { NumberTicker } from '@/components/ui/number-ticker';
import { Skeleton } from '@/components/ui/skeleton';
import { Toaster, toast, useToastStore } from '@/components/ui/toast';

afterEach(() => {
  act(() => useToastStore.setState({ toasts: [] }));
  vi.useRealTimers();
});

describe('brand UI primitives', () => {
  it('shows, announces and dismisses toasts', async () => {
    render(<Toaster />);
    act(() => {
      toast.success('Saved', { description: 'Team updated', duration: 0 });
      toast.error('Upload failed', { duration: 0 });
    });
    // Sonner publishes on the next tick.
    expect(await screen.findByRole('status')).toHaveTextContent('SavedTeam updated');
    expect(screen.getByRole('alert')).toHaveTextContent('Upload failed');
    await userEvent.click(
      within(screen.getByRole('status')).getByRole('button', { name: 'Dismiss notification' }),
    );
    // Sonner keeps the node for its exit transition before unmounting it.
    await waitFor(() => expect(screen.queryByText('Saved')).not.toBeInTheDocument());
  });

  it('auto-dismisses toasts after their duration', () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => {
      toast('Copied', { duration: 1000 });
    });
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(screen.getByText('Copied')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    act(() => {
      vi.advanceTimersByTime(500); // exit transition
    });
    expect(screen.queryByText('Copied')).not.toBeInTheDocument();
  });

  it('offers highlight/live badge and shimmer/highlight button variants', () => {
    render(
      <>
        <Badge variant="live">Live</Badge>
        <Button variant="highlight">Rose</Button>
        <Button variant="shimmer">Shine</Button>
      </>,
    );
    expect(screen.getByText('Live').className).toContain('text-highlight');
    expect(screen.getByRole('button', { name: 'Rose' }).className).toContain('bg-highlight');
    expect(screen.getByRole('button', { name: 'Shine' }).className).toContain('shimmer');
  });

  it('hides skeletons from assistive tech', () => {
    render(<Skeleton data-testid="sk" />);
    expect(screen.getByTestId('sk')).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders the final number for screen readers and under reduced motion', () => {
    const mm = vi.fn().mockReturnValue({ matches: true });
    vi.stubGlobal('matchMedia', mm);
    try {
      render(<NumberTicker value={1234} />);
      expect(screen.getAllByText('1,234')).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('BrandBackground', () => {
  it('renders children over a decorative, hidden backdrop with a shader slot', async () => {
    const { BrandBackground } = await import('@/components/brand/brand-background');
    render(
      <BrandBackground intensity="hero">
        <p>Sign in</p>
      </BrandBackground>,
    );
    const root = screen.getByTestId('brand-background');
    expect(root).toHaveTextContent('Sign in');
    const slot = root.querySelector('[data-slot="brand-background-shader"]');
    expect(slot).not.toBeNull();
    expect(slot?.parentElement).toHaveAttribute('aria-hidden', 'true');
  });
});
