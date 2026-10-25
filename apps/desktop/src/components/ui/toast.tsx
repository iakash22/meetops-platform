import { X } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Minimal toast for non-field errors (field errors stay inline under their field). Pinned bottom-right,
 * announced via role="alert", dismissible. Enter animation is a 200ms fade that prefers-reduced-motion disables.
 */
export function Toast({
  message,
  onDismiss,
  className,
}: {
  message: string | null;
  onDismiss: () => void;
  className?: string;
}) {
  if (!message) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-end p-4">
      <div
        role="alert"
        className={cn(
          'toast-enter pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border border-destructive/50 bg-card px-4 py-3 text-sm text-destructive-text shadow-lg',
          className,
        )}
      >
        <p className="flex-1">{message}</p>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-m-1 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
