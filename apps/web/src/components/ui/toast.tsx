import { CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { create } from 'zustand';
import { cn } from '@/lib/utils';

/**
 * Sonner-style toasts without the dependency: call `toast('Saved')`, `toast.success(...)`,
 * `toast.error(...)` anywhere and mount `<Toaster />` once at the app root.
 */
export type ToastVariant = 'default' | 'success' | 'error';

export type ToastItem = {
  id: number;
  title: string;
  description?: string | undefined;
  variant: ToastVariant;
};

type ToastOptions = { description?: string | undefined; duration?: number | undefined };

type ToastState = {
  toasts: ToastItem[];
  push: (t: Omit<ToastItem, 'id'>, duration?: number) => number;
  dismiss: (id: number) => void;
};

let nextId = 1;
const DEFAULT_DURATION = 4000;
const MAX_VISIBLE = 4;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (t, duration = DEFAULT_DURATION) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { ...t, id }].slice(-MAX_VISIBLE) }));
    if (duration > 0 && Number.isFinite(duration)) {
      setTimeout(() => get().dismiss(id), duration);
    }
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

function make(variant: ToastVariant) {
  return (title: string, opts: ToastOptions = {}) =>
    useToastStore.getState().push({ title, description: opts.description, variant }, opts.duration);
}

export const toast = Object.assign(make('default'), {
  success: make('success'),
  error: make('error'),
  dismiss: (id: number) => useToastStore.getState().dismiss(id),
});

const icons = { default: Info, success: CheckCircle2, error: XCircle } as const;
const iconTone = {
  default: 'text-link',
  success: 'text-emerald-400',
  error: 'text-destructive',
} as const;

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  return (
    <section
      aria-label="Notifications"
      className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
    >
      {toasts.map((t) => {
        const Icon = icons[t.variant];
        return (
          <div
            key={t.id}
            role={t.variant === 'error' ? 'alert' : 'status'}
            data-variant={t.variant}
            className={cn(
              'surface-glass pointer-events-auto flex animate-toast-in items-start gap-3 rounded-lg border p-4 text-sm shadow-lg shadow-black/40',
              t.variant === 'error' && 'border-destructive/50',
            )}
          >
            <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', iconTone[t.variant])} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-foreground">{t.title}</p>
              {t.description ? (
                <p className="mt-0.5 text-muted-foreground">{t.description}</p>
              ) : null}
            </div>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => dismiss(t.id)}
              className="rounded-sm text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        );
      })}
    </section>
  );
}
