import type { ReactNode } from 'react';

import { BrandMark } from '@/components/brand';

/** Shared frame for the sign-in / sign-up screens: brand backdrop, centred mark, card slot and footer note. */
export function AuthLayout({ children, footer }: { children: ReactNode; footer: ReactNode }) {
  return (
    <div className="brand-backdrop flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <BrandMark className="justify-center" />
        {children}
        <p className="text-center text-sm text-muted-foreground">{footer}</p>
      </div>
    </div>
  );
}

/** "New to MeetOps? Create an account" style switcher between the two auth screens. */
export function AuthSwitch({
  prompt,
  action,
  onClick,
}: {
  prompt: string;
  action: string;
  onClick: () => void;
}) {
  return (
    <p className="text-center text-sm text-muted-foreground">
      {prompt}{' '}
      <button
        type="button"
        onClick={onClick}
        className="rounded-sm font-medium text-link underline-offset-4 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        {action}
      </button>
    </p>
  );
}

/** Inline field error, rendered directly under its input and referenced by aria-describedby. */
export function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} className="text-xs text-destructive-text">
      {message}
    </p>
  );
}
