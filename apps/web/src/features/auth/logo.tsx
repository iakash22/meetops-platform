import { cn } from '@/lib/utils';

/**
 * MeetOps AI mark + wordmark. There is no logo asset in the repo yet, so the mark is a
 * token-coloured inline SVG (audio bars turning into a check: "meeting → action").
 * TODO(brand): swap for the final logo asset when design ships one.
 */
export function MeetOpsLogo({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <svg viewBox="0 0 32 32" className="h-8 w-8 shrink-0" aria-hidden="true">
        <defs>
          <linearGradient id="meetops-mark" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="hsl(var(--primary))" />
            <stop offset="1" stopColor="hsl(var(--link))" />
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx="8" fill="url(#meetops-mark)" />
        <g
          fill="none"
          stroke="hsl(var(--primary-foreground))"
          strokeLinecap="round"
          strokeWidth="2.5"
        >
          <path d="M8 13v6M12.5 10v12M17 14v4" />
          <path d="M19.5 17.5l2.5 2.5 4.5-6" strokeLinejoin="round" />
        </g>
      </svg>
      <span className="text-lg font-semibold tracking-tight">
        MeetOps <span className="text-link">AI</span>
      </span>
    </span>
  );
}
