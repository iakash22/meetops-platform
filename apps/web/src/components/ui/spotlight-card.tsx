import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Card with a soft cerulean spotlight that follows the pointer (CSS custom properties only,
 * no animation library). Static under prefers-reduced-motion because nothing animates on its own.
 * Original implementation, inspired by the "spotlight card" pattern seen on Aceternity UI / 21st.dev.
 */
const SpotlightCard = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, onPointerMove, style, ...props }, ref) => {
    const handleMove = (e: React.PointerEvent<HTMLDivElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      e.currentTarget.style.setProperty('--spot-x', `${e.clientX - r.left}px`);
      e.currentTarget.style.setProperty('--spot-y', `${e.clientY - r.top}px`);
      onPointerMove?.(e);
    };
    return (
      <div
        ref={ref}
        onPointerMove={handleMove}
        style={style}
        className={cn(
          'group relative overflow-hidden rounded-xl border bg-card text-card-foreground transition-colors duration-200 hover:border-primary/50',
          "before:pointer-events-none before:absolute before:inset-0 before:opacity-0 before:transition-opacity before:duration-200 before:content-[''] hover:before:opacity-100",
          'before:bg-[radial-gradient(320px_circle_at_var(--spot-x,50%)_var(--spot-y,0%),hsl(var(--primary)/0.16),transparent_60%)]',
          className,
        )}
        {...props}
      />
    );
  },
);
SpotlightCard.displayName = 'SpotlightCard';

/** Wraps children in an animated cerulean→rose gradient border (CSS-only; static when motion is reduced). */
function GradientBorder({
  className,
  innerClassName,
  children,
}: {
  className?: string;
  innerClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('gradient-border rounded-xl p-px', className)}>
      <div className={cn('h-full rounded-[calc(var(--radius)+3px)] bg-card', innerClassName)}>
        {children}
      </div>
    </div>
  );
}

export { SpotlightCard, GradientBorder };
