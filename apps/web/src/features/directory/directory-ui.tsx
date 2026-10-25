import { forwardRef, useState, type ReactNode } from 'react';
import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query';
import { EmptyState, ErrorState, LoadingState } from '@/components/states/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea, type TextareaProps } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/api/client';
import type { CursorPage } from './contracts-shim';
import { flatItems } from './queries';

/** Loading / error / empty / list states plus "Load more" for a cursor-paged query. */
export function InfiniteList<T>({
  query,
  label,
  emptyTitle,
  emptyDescription,
  getKey,
  renderItem,
}: {
  query: UseInfiniteQueryResult<InfiniteData<CursorPage<T>>>;
  label: string;
  emptyTitle: string;
  emptyDescription?: string;
  getKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
}) {
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (query.isPending && query.fetchStatus !== 'idle') return <LoadingState />;
  const items = flatItems(query.data);
  if (items.length === 0)
    return (
      <EmptyState
        title={emptyTitle}
        {...(emptyDescription ? { description: emptyDescription } : {})}
      />
    );
  return (
    <div className="space-y-3">
      <ul aria-label={label} className="divide-y rounded-lg border">
        {items.map((item) => (
          <li key={getKey(item)} className="p-3">
            {renderItem(item)}
          </li>
        ))}
      </ul>
      {query.hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      ) : null}
    </div>
  );
}

/** Two-step delete: first click asks, second confirms. Errors are shown inline. */
export function ConfirmDeleteButton({
  label,
  onConfirm,
}: {
  label: string;
  onConfirm: () => Promise<unknown>;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!armed)
    return (
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Delete ${label}`}
        onClick={() => setArmed(true)}
      >
        Delete
      </Button>
    );
  return (
    <span className="flex items-center gap-2">
      {error ? (
        <span className="text-sm text-destructive">{mutationErrorMessage(error)}</span>
      ) : null}
      <Button
        variant="destructive"
        size="sm"
        disabled={busy}
        aria-label={`Confirm delete ${label}`}
        onClick={() => {
          setBusy(true);
          setError(null);
          onConfirm()
            .catch((e: unknown) => setError(e))
            .finally(() => setBusy(false));
        }}
      >
        Confirm
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setArmed(false)}>
        Cancel
      </Button>
    </span>
  );
}

/** Fixed text for write failures; server messages are never shown. */
export function mutationErrorMessage(error: unknown, conflict?: string): string {
  if (error instanceof ApiError) {
    if (error.status === 409 && conflict) return conflict;
    if (error.status === 403) return "You don't have permission to do that.";
    if (error.status === 404) return 'It no longer exists. Refresh and try again.';
    if (error.status === 400) return 'Some of the information provided is invalid.';
  }
  return 'Something went wrong. Please try again.';
}

export function FormError({ error, conflict }: { error: unknown; conflict?: string }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {mutationErrorMessage(error, conflict)}
    </p>
  );
}

export type SelectOption = { value: string; label: string };

/** Radix items cannot carry '' as a value; '' (none / all) maps to this sentinel and back. */
const NONE = '__none__';

/**
 * Labelled shared `components/ui/select` (Radix) for directory forms and filters. `value` ''
 * means "none": pass `emptyLabel` to offer it as an item, else it shows `placeholder`.
 */
export function SelectField({
  label,
  name,
  value,
  onValueChange,
  options,
  emptyLabel,
  placeholder,
  error,
  disabled,
}: {
  label: string;
  name: string;
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  emptyLabel?: string;
  placeholder?: string;
  error?: string | undefined;
  disabled?: boolean;
}) {
  const id = `${name}-select`;
  const errorId = `${id}-error`;
  const current = value === '' ? (emptyLabel ? NONE : '') : value;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select
        name={name}
        value={current}
        {...(disabled ? { disabled } : {})}
        onValueChange={(v) => onValueChange(v === NONE ? '' : v)}
      >
        <SelectTrigger
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        >
          <SelectValue placeholder={placeholder ?? emptyLabel ?? 'Choose…'} />
        </SelectTrigger>
        <SelectContent>
          {emptyLabel ? <SelectItem value={NONE}>{emptyLabel}</SelectItem> : null}
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

type TextAreaFieldProps = TextareaProps & {
  label: string;
  name: string;
  error?: string | undefined;
};

export const TextAreaField = forwardRef<HTMLTextAreaElement, TextAreaFieldProps>(
  function TextAreaField({ label, error, id, name, ...props }, ref) {
    const inputId = id ?? name;
    return (
      <div className="grid gap-1.5">
        <Label htmlFor={inputId}>{label}</Label>
        <Textarea
          id={inputId}
          name={name}
          ref={ref}
          rows={3}
          aria-invalid={error ? true : undefined}
          {...props}
        />
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    );
  },
);

/** Search box; the caller debounces nothing, it filters on submit-free change (small lists). */
export function SearchBox({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Input
      type="search"
      aria-label={label}
      placeholder={label}
      value={value}
      maxLength={200}
      onChange={(e) => onChange(e.target.value)}
      className="max-w-xs"
    />
  );
}
