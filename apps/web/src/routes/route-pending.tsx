import { Skeleton } from '@/components/ui/skeleton';

/**
 * Shown while a lazy page chunk loads (only after the router's default 1 s pending delay,
 * so fast networks never flash it). Static skeleton: no motion beyond the shared
 * shimmer, which index.css disables under prefers-reduced-motion.
 */
export function RoutePending() {
  return (
    <div role="status" aria-label="Loading page" className="grid gap-4 p-6">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-4 w-full max-w-xl" />
      <Skeleton className="h-4 w-2/3 max-w-md" />
    </div>
  );
}
