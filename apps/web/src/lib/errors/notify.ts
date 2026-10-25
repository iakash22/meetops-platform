import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { toast } from '@/components/ui/toast';
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
  error: (title: string, description?: string) =>
    // Errors stay up longer (≥5s); the user can dismiss them.
    toast.error(title, { description, duration: 8000 }),
};

/** Status 0 or a fetch TypeError: the API could not be reached at all. */
export function isNetworkError(err: unknown): boolean {
  return (
    (err instanceof ApiError && err.status === 0 && err.code !== 'BAD_REQUEST') ||
    err instanceof TypeError
  );
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

/** Toast an error that isn't tied to a form field. Server messages are never shown. */
export function toastError(err: unknown, opts: { title?: string } = {}): void {
  const title = opts.title ?? errorTitle(err);
  const { message } = describeError(err);
  notify.error(title, isNetworkError(err) ? 'Check your connection and try again.' : message);
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
