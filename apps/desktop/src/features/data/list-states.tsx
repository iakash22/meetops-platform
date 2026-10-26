import { Loader2, RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Toast } from '@/components/ui/toast';
import { useEffect, useState } from 'react';

export function ListLoading({ label }: { label: string }) {
  return (
    <p role="status" className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
      <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
      Loading {label}…
    </p>
  );
}

/** Non-field error: inline retry plus an animated toast (project standard). */
export function ListError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const [toast, setToast] = useState<string | null>(message);
  useEffect(() => setToast(message), [message]);
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <p className="text-sm text-muted-foreground">Nothing to show right now.</p>
      <Button variant="outline" onClick={onRetry}>
        <RotateCcw aria-hidden />
        Retry
      </Button>
      <Toast message={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
