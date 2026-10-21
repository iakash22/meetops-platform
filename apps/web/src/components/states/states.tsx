import type { ReactNode } from 'react';
import { AlertCircle, Inbox, Loader2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { describeError } from '@/lib/api/error-messages';

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div
      role="status"
      data-testid="empty-state"
      className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-10 text-center"
    >
      <Inbox className="h-8 w-8 text-muted-foreground" aria-hidden />
      <h3 className="text-lg font-semibold">{title}</h3>
      {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      {action}
    </div>
  );
}

export function LoadingState({ label = 'Loading…', rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      data-testid="loading-state"
      className="space-y-3"
    >
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        <span>{label}</span>
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  error,
  onRetry,
}: {
  title?: string;
  error?: unknown;
  onRetry?: () => void;
}) {
  const { message, requestId } = describeError(error);
  return (
    <Alert variant="destructive" data-testid="error-state">
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="flex flex-col gap-3">
        <span>{message}</span>
        {requestId ? (
          <span className="text-xs" data-testid="request-id">
            Reference: {requestId}
          </span>
        ) : null}
        {onRetry ? (
          <Button variant="outline" size="sm" className="w-fit" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
