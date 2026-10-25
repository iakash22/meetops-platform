import { AudioLines } from 'lucide-react';

import { cn } from '@/lib/utils';

/** Brand mark: Cerulean tile with a soft glow (no heavy drop shadow). `compact` hides the wordmark visually. */
export function BrandMark({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <span
        aria-hidden
        className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-glow-primary"
      >
        <AudioLines className="size-4" />
      </span>
      <span className={cn('text-base font-semibold tracking-tight', compact && 'sr-only')}>
        MeetOps <span className="text-accent">AI</span>
      </span>
    </div>
  );
}
