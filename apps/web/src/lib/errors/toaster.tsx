import { useEffect, useState } from 'react';
import { CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { Toaster as SonnerToaster, toast as sonner } from 'sonner';
import { cn } from '@/lib/utils';

/**
 * App toasts on Sonner: stacking/expand-on-hover, swipe-to-dismiss and the queue come from
 * Sonner; the markup is ours so colours stay on brand (card #141416, border #2A2A2E,
 * success #007BA7, error #EF4444, never rose) and errors are announced assertively
 * (`role="alert"`) while everything else is polite (`role="status"`).
 * Mount `<AppToaster />` once at the app root; call sites use `notify` / `toastError`.
 */
export type ToastVariant = 'default' | 'success' | 'error';

const ICONS = { default: Info, success: CheckCircle2, error: XCircle } as const;
const ICON_TONE = {
  default: 'text-link',
  success: 'text-[#007BA7]',
  error: 'text-[#EF4444]',
} as const;

export function showToast(
  variant: ToastVariant,
  title: string,
  opts: { description?: string | undefined; duration?: number | undefined } = {},
): string | number {
  const Icon = ICONS[variant];
  return sonner.custom(
    (id) => (
      <div
        role={variant === 'error' ? 'alert' : 'status'}
        data-variant={variant}
        className={cn(
          'flex w-[min(24rem,calc(100vw-2rem))] items-start gap-3 rounded-lg border border-[#2A2A2E] bg-[#141416] p-4 text-sm text-foreground shadow-lg shadow-black/40',
          variant === 'error' && 'border-[#EF4444]/50',
        )}
      >
        <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', ICON_TONE[variant])} aria-hidden="true" />
        <div className="grid flex-1 gap-0.5">
          <p className="font-medium">{title}</p>
          {opts.description ? <p className="text-muted-foreground">{opts.description}</p> : null}
        </div>
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={() => sonner.dismiss(id)}
          className="-m-1 rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    ),
    opts.duration === undefined ? {} : { duration: opts.duration },
  );
}

export const dismissAllToasts = () => sonner.dismiss();

const MOBILE_QUERY = '(max-width: 639px)';

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.(MOBILE_QUERY).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia?.(MOBILE_QUERY);
    if (!mql) return;
    const onChange = () => setMobile(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return mobile;
}

export function AppToaster() {
  const mobile = useIsMobile();
  return (
    <SonnerToaster
      richColors={false}
      theme="dark"
      position={mobile ? 'top-center' : 'bottom-right'}
      visibleToasts={4}
      gap={8}
      // Reduced motion: Sonner honours prefers-reduced-motion for its own transitions.
      toastOptions={{ unstyled: true }}
      containerAriaLabel="Notifications"
    />
  );
}
