import * as React from 'react';

import { cn } from '@/lib/utils';

export interface TextareaProps extends React.ComponentProps<'textarea'> {
  /**
   * Grow with content using CSS `field-sizing: content` (Chromium 123+). Browsers without support
   * keep a normal resizable textarea, so no JS fallback is needed. Cap growth with `max-h-*`.
   */
  autoResize?: boolean;
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, autoResize = false, ...props }, ref) => {
    return (
      <textarea
        data-slot="textarea"
        data-autoresize={autoResize ? '' : undefined}
        className={cn(
          'flex min-h-[80px] w-full rounded-md border border-input bg-card px-3 py-2 text-base transition-[border-color,box-shadow] duration-150 placeholder:text-muted-foreground hover:border-muted-foreground/60 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive/40 md:text-sm',
          autoResize && 'resize-none overflow-y-auto [field-sizing:content]',
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Textarea.displayName = 'Textarea';

export { Textarea };
