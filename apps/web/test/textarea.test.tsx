import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

describe('Textarea', () => {
  it('is labelled, forwards ref and accepts typing', async () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(
      <>
        <Label htmlFor="notes">Notes</Label>
        <Textarea id="notes" ref={ref} placeholder="Add notes" />
      </>,
    );
    const el = screen.getByRole('textbox', { name: 'Notes' });
    expect(ref.current).toBe(el);
    await userEvent.type(el, 'hello');
    expect(el).toHaveValue('hello');
  });

  it('uses brand tokens and focus ring, merging custom classes', () => {
    render(<Textarea aria-label="t" className="max-h-40" />);
    const el = screen.getByRole('textbox');
    expect(el).toHaveClass('bg-card', 'border-input', 'focus-visible:ring-ring/40', 'max-h-40');
    expect(el).toHaveAttribute('data-slot', 'textarea');
    expect(el).not.toHaveAttribute('data-autoresize');
  });

  it('styles aria-invalid with destructive tokens', () => {
    render(<Textarea aria-label="t" aria-invalid="true" aria-describedby="err" />);
    const el = screen.getByRole('textbox');
    expect(el).toBeInvalid();
    expect(el.className).toContain('aria-[invalid=true]:border-destructive');
    expect(el).toHaveAttribute('aria-describedby', 'err');
  });

  it('opts into CSS field-sizing autosize', () => {
    render(<Textarea aria-label="t" autoResize />);
    const el = screen.getByRole('textbox');
    expect(el).toHaveAttribute('data-autoresize');
    expect(el).toHaveClass('[field-sizing:content]', 'resize-none');
  });

  it('respects disabled', () => {
    render(<Textarea aria-label="t" disabled />);
    expect(screen.getByRole('textbox')).toBeDisabled();
  });
});
