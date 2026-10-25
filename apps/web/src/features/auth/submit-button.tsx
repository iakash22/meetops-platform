import type { ComponentProps } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { authButtonClass } from './styles';

/** Full-width 44px submit button that keeps its width and shows a spinner while busy. */
export function SubmitButton({
  busy,
  busyLabel,
  children,
  className,
  ...props
}: ComponentProps<typeof Button> & { busy: boolean; busyLabel: string }) {
  return (
    <Button
      type="submit"
      disabled={busy}
      aria-busy={busy || undefined}
      className={cn(authButtonClass, className)}
      {...props}
    >
      {busy ? (
        <>
          <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />
          {busyLabel}
        </>
      ) : (
        children
      )}
    </Button>
  );
}
