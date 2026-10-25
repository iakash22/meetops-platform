import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * Heading patterns from docs/05-web/typography-and-motion.md. Pure markup + tokens; no motion.
 */

/** Small uppercase label above a title ("eyebrow"). Muted by default; `tone="highlight"` for live/new. */
export function Overline({
  children,
  className,
  tone = 'muted',
}: {
  children: ReactNode;
  className?: string;
  tone?: 'muted' | 'link' | 'highlight';
}) {
  return (
    <p
      className={cn(
        'text-overline uppercase',
        tone === 'muted' && 'text-muted-foreground',
        tone === 'link' && 'text-link',
        tone === 'highlight' && 'text-highlight',
        className,
      )}
    >
      {children}
    </p>
  );
}

/** Page title (h1) + optional eyebrow, description and right-aligned actions. One per page. */
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="page-header"
      className={cn('mb-8 flex flex-wrap items-end justify-between gap-4', className)}
    >
      <div className="min-w-0 space-y-1">
        {eyebrow ? <Overline>{eyebrow}</Overline> : null}
        <h1 className="text-h1 text-foreground">{title}</h1>
        {description ? (
          <p className="measure text-body text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Section header inside a page (h2 by default; pass `as="h3"` when nested). */
export function SectionHeader({
  title,
  description,
  actions,
  as: Heading = 'h2',
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  as?: 'h2' | 'h3';
  className?: string;
}) {
  return (
    <div
      data-slot="section-header"
      className={cn('mb-4 flex flex-wrap items-end justify-between gap-3', className)}
    >
      <div className="min-w-0 space-y-0.5">
        <Heading className={cn(Heading === 'h2' ? 'text-h4' : 'text-h5', 'text-foreground')}>
          {title}
        </Heading>
        {description ? (
          <p className="measure text-small text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Format seconds as m:ss or h:mm:ss (negative/NaN → 0:00). */
export function formatTimecode(totalSeconds: number): string {
  const s = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** Timestamp / duration in the mono face with tabular digits, as a semantic <time>. */
export function Timecode({ seconds, className }: { seconds: number; className?: string }) {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return (
    <time
      dateTime={`PT${s}S`}
      className={cn('timecode text-small text-muted-foreground', className)}
    >
      {formatTimecode(s)}
    </time>
  );
}
