import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Brand backdrop for auth and landing/hero surfaces: Jet Black base, cerulean + rose glows and a
 * faint masked grid — pure CSS, zero JS, no animation (so nothing to disable for reduced motion).
 *
 * `data-slot="brand-background-shader"` is the reserved mount point for a future WebGPU shader
 * (see docs/05-web/brand-theme.md → "Shader background follow-up"). The shader must be lazy-loaded
 * only on auth/landing, feature-detect `navigator.gpu`, and leave this CSS fallback in place
 * whenever it is unavailable, motion is reduced, or the device is low-power.
 */
export function BrandBackground({
  children,
  className,
  intensity = 'default',
  grid = true,
}: {
  children?: ReactNode;
  className?: string;
  /** `subtle` for dense app screens, `default` for auth, `hero` for landing. */
  intensity?: 'subtle' | 'default' | 'hero';
  grid?: boolean;
}) {
  const glow = { subtle: 0.1, default: 0.18, hero: 0.28 }[intensity];
  return (
    <div
      data-testid="brand-background"
      className={cn('relative isolate overflow-hidden bg-background', className)}
    >
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
        <div
          className="absolute inset-0"
          style={{
            background: [
              `radial-gradient(60% 50% at 15% 0%, hsl(var(--primary) / ${glow}), transparent 70%)`,
              `radial-gradient(45% 40% at 90% 100%, hsl(var(--highlight) / ${glow * 0.6}), transparent 70%)`,
            ].join(', '),
          }}
        />
        {grid ? (
          <div className="bg-grid absolute inset-0 opacity-60 [mask-image:radial-gradient(70%_60%_at_50%_30%,black,transparent)]" />
        ) : null}
        <div data-slot="brand-background-shader" className="absolute inset-0" />
      </div>
      {children}
    </div>
  );
}
