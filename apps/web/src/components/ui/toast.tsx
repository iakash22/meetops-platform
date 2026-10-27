import { CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { Toaster as SonnerToaster, toast as sonner } from 'sonner';
import { create } from 'zustand';
import { cn } from '@/lib/utils';

/**
 * Toasts rendered by Sonner (https://sonner.emilkowal.ski, MIT). Call `toast('Saved')`,
 * `toast.success(...)`, `toast.error(...)` anywhere and mount `<Toaster />` once at the app
 * root. A small store mirrors what is on screen so callers (and tests) can read or update a
 * toast by id; Sonner owns stacking, swipe-to-dismiss, hover-pause and the live region.
 * Each toast body is our own card (`sonner.custom`) so it follows the brand theme exactly.
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
  update: (id: number, patch: Partial<Omit<ToastItem, 'id'>>) => void;
  dismiss: (id: number) => void;
};

let nextId = 1;
const DEFAULT_DURATION = 5000;
const MAX_VISIBLE = 4;

function show(item: ToastItem, duration: number) {
  sonner.custom((sid) => <ToastCard item={item} onDismiss={() => sonner.dismiss(sid)} />, {
    id: item.id,
    duration: duration > 0 && Number.isFinite(duration) ? duration : Infinity,
    onDismiss: () => useToastStore.getState().forget(item.id),
    onAutoClose: () => useToastStore.getState().forget(item.id),
  });
}

export const useToastStore = create<ToastState & { forget: (id: number) => void }>((set, get) => ({
  toasts: [],
  push: (t, duration = DEFAULT_DURATION) => {
    const id = nextId++;
    const item = { ...t, id };
    set((s) => ({ toasts: [...s.toasts, item].slice(-MAX_VISIBLE) }));
    show(item, duration);
    if (duration > 0 && Number.isFinite(duration)) {
      setTimeout(() => get().forget(id), duration);
    }
    return id;
  },
  update: (id, patch) => {
    const current = get().toasts.find((t) => t.id === id);
    if (!current) return;
    const item = { ...current, ...patch };
    set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? item : t)) }));
    // Same id: Sonner replaces the content in place (no re-announce of a new toast).
    sonner.custom((sid) => <ToastCard item={item} onDismiss={() => sonner.dismiss(sid)} />, {
      id,
    });
  },
  forget: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  dismiss: (id) => {
    sonner.dismiss(id);
    get().forget(id);
  },
}));

// Clearing the store (sign-out, test reset) clears what Sonner still shows/replays.
useToastStore.subscribe((state, prev) => {
  if (state.toasts.length === 0 && prev.toasts.length > 0) sonner.dismiss();
});

function make(variant: ToastVariant) {
  return (title: string, opts: ToastOptions = {}) =>
    useToastStore.getState().push({ title, description: opts.description, variant }, opts.duration);
}

export const toast = Object.assign(make('default'), {
  success: make('success'),
  error: make('error'),
  update: (id: number, patch: Partial<Omit<ToastItem, 'id'>>) =>
    useToastStore.getState().update(id, patch),
  dismiss: (id: number) => useToastStore.getState().dismiss(id),
});

const icons = { default: Info, success: CheckCircle2, error: XCircle } as const;
const iconTone = {
  default: 'text-link',
  success: 'text-emerald-400',
  error: 'text-destructive',
} as const;

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const Icon = icons[item.variant];
  return (
    <div
      role={item.variant === 'error' ? 'alert' : 'status'}
      data-variant={item.variant}
      className={cn(
        'surface-glass pointer-events-auto flex w-[min(24rem,calc(100vw-2rem))] items-start gap-3 rounded-lg border p-4 text-sm shadow-lg shadow-black/40',
        item.variant === 'error' && 'border-destructive/50',
      )}
    >
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', iconTone[item.variant])} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">{item.title}</p>
        {item.description ? (
          <p className="mt-0.5 text-muted-foreground">{item.description}</p>
        ) : null}
      </div>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={onDismiss}
        className="-m-3 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

export function Toaster() {
  return (
    <SonnerToaster
      theme="dark"
      position="bottom-right"
      visibleToasts={MAX_VISIBLE}
      containerAriaLabel="Notifications"
      toastOptions={{ unstyled: true }}
    />
  );
}
