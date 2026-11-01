import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { toast, useToastStore, type ToastAction } from '@/components/ui/toast';
import { ApiError } from '@/lib/api/client';
import { describeError } from '@/lib/api/error-messages';

/**
 * App-wide error routing (docs/05-web/auth-pages.md → "Error handling"):
 * - errors tied to a form field render inline under that field (`applyFieldErrors`);
 * - everything else (network, 5xx, 429, session expired, CSRF, generic) goes to a toast
 *   (`toastError`).
 *
 * Call sites use only `notify` / `toastError` / `applyFieldErrors`, so the toast backend
 * (today #132's `ui/toast`, later Sonner) can be swapped here without touching them.
 */
export const notify = {
  success: (title: string, description?: string) => toast.success(title, { description }),
  info: (title: string, description?: string) => toast(title, { description }),
  error: (title: string, description?: string, action?: ToastAction) =>
    // Errors stay up longer (≥5s); the user can dismiss them. With an action (Retry) they stay
    // until dismissed so the button can't vanish while someone is reaching for it.
    toast.error(title, { description, duration: action ? Infinity : 8000, action }),
};

/** Status 0 or a fetch TypeError: the API could not be reached at all. */
export function isNetworkError(err: unknown): boolean {
  return (
    (err instanceof ApiError && err.status === 0 && err.code !== 'BAD_REQUEST') ||
    err instanceof TypeError
  );
}

/**
 * Worth offering "Retry": the request may succeed unchanged on a second try (network down,
 * 5xx, or a CSRF token that the client refreshes). Never for 4xx the user must fix, 401
 * (session over), 404, or 429 (that toast has its own countdown).
 */
export function isRetryableError(err: unknown): boolean {
  if (isNetworkError(err)) return true;
  if (!(err instanceof ApiError)) return false;
  return err.isCsrfFailure || err.status >= 500;
}

/** Fixed, user-facing title for an error that isn't tied to a field. */
export function errorTitle(err: unknown): string {
  if (isNetworkError(err)) return "Can't reach MeetOps right now";
  if (err instanceof ApiError) {
    if (err.isCsrfFailure) return 'Session expired, please try again';
    if (err.status === 401 && err.code === 'UNAUTHENTICATED') return 'Your session has ended';
    if (err.status === 429) return 'Too many attempts';
    if (err.status >= 500) return "Can't reach MeetOps right now";
  }
  return 'Something went wrong';
}

const retryCopy = (s: number) => `Try again in ${s} second${s === 1 ? '' : 's'}.`;

/**
 * Rate-limit toast with a live Retry-After countdown. The text updates once per second in
 * place (same toast id, so screen readers are not re-alerted each tick); at 0 it switches to
 * "You can try again now." and auto-dismisses a few seconds later.
 */
function toastRateLimited(title: string, seconds: number): void {
  const id = toast.error(title, { description: retryCopy(seconds), duration: Infinity });
  let left = seconds;
  const timer = setInterval(() => {
    left -= 1;
    if (!useToastStore.getState().toasts.some((t) => t.id === id)) {
      clearInterval(timer);
      return;
    }
    if (left > 0) {
      toast.update(id, { description: retryCopy(left) });
      return;
    }
    clearInterval(timer);
    toast.update(id, { description: 'You can try again now.' });
    setTimeout(() => toast.dismiss(id), 5000);
  }, 1000);
}

/**
 * Toast an error that isn't tied to a form field. Server messages are never shown.
 * Pass `onRetry` to offer a Retry button; it only appears for retryable errors
 * (`isRetryableError`), so callers can pass it unconditionally.
 */
export function toastError(
  err: unknown,
  opts: { title?: string; onRetry?: (() => void) | undefined } = {},
): void {
  const title = opts.title ?? errorTitle(err);
  if (err instanceof ApiError && err.status === 429 && err.retryAfterSeconds) {
    toastRateLimited(title, err.retryAfterSeconds);
    return;
  }
  const { message } = describeError(err);
  const action =
    opts.onRetry && isRetryableError(err) ? { label: 'Retry', onClick: opts.onRetry } : undefined;
  notify.error(
    title,
    isNetworkError(err) ? 'Check your connection and try again.' : message,
    action,
  );
}

/**
 * Map API validation details (`{ path: '/email', message }`) onto react-hook-form fields.
 * Messages are the caller's fixed copy per field (server text is never shown); fields
 * without copy get a generic one. Returns true when at least one field was set, so the
 * caller can skip the toast.
 */
export function applyFieldErrors<TValues extends FieldValues>(
  setError: UseFormSetError<TValues>,
  err: unknown,
  fields: Partial<Record<Path<TValues>, string>>,
): boolean {
  if (!(err instanceof ApiError) || err.details.length === 0) return false;
  if (err.status !== 400 && err.status !== 422) return false;
  let applied = false;
  for (const d of err.details) {
    const name = d.path.replace(/^\//, '').split('/')[0] as Path<TValues>;
    if (!(name in fields)) continue;
    setError(
      name,
      { type: 'server', message: fields[name] || "This value isn't valid." },
      { shouldFocus: !applied },
    );
    applied = true;
  }
  return applied;
}
