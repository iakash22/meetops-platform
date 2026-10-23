import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { EmptyState, ErrorState, LoadingState } from '@/components/states/states';
import type { Paginated } from '@meetops/contracts';

/** Renders loading / error / empty / list states for a paginated query. */
export function ResourceList<T extends { id: string }>({
  query,
  emptyTitle,
  emptyDescription,
  renderItem,
}: {
  query: UseQueryResult<Paginated<T>>;
  emptyTitle: string;
  emptyDescription?: string;
  renderItem: (item: T) => ReactNode;
}) {
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (query.isPending && query.fetchStatus !== 'idle') return <LoadingState />;
  const items = query.data?.items ?? [];
  if (items.length === 0)
    return (
      <EmptyState
        title={emptyTitle}
        {...(emptyDescription ? { description: emptyDescription } : {})}
      />
    );
  return (
    <ul className="divide-y rounded-lg border">
      {items.map((item) => (
        <li key={item.id} className="p-3">
          {renderItem(item)}
        </li>
      ))}
    </ul>
  );
}

export function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
    </div>
  );
}
