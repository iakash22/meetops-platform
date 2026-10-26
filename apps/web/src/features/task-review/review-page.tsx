import { memo, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Check, X } from 'lucide-react';
import type { ExtractedTask, Paginated, TaskPriority } from '@meetops/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EmptyState, ErrorState, LoadingState } from '@/components/states/states';
import { ApiError } from '@/lib/api/client';
import { useApi } from '@/lib/api/context';
import { useOrganizationId } from '@/lib/api/queries';
import { notify, toastError } from '@/lib/errors/notify';
import { PageHeader } from '@/pages/resource-list';
import { createTaskReviewApi, type AcceptExtractedTaskRequest } from './api';

const PRIORITIES: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];

export function confidenceLabel(c: number): { text: string; low: boolean } {
  const pct = Math.round(c * 100);
  return { text: `${pct}% confidence`, low: c < 0.6 };
}

/** Inline field validation for the accept form (title is required, ≤500 chars like Task.title). */
export function validateTitle(title: string): string | null {
  const t = title.trim();
  if (!t) return 'Enter a title.';
  if (t.length > 500) return 'Keep the title under 500 characters.';
  return null;
}

function useReviewApi() {
  const api = useApi();
  return useMemo(() => createTaskReviewApi(api.request), [api]);
}

const ReviewCard = memo(function ReviewCard({
  item,
  onAccept,
  onDismiss,
  busy,
}: {
  item: ExtractedTask;
  onAccept: (body: AcceptExtractedTaskRequest) => void;
  onDismiss: () => void;
  busy: boolean;
}) {
  const [title, setTitle] = useState(item.title);
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [error, setError] = useState<string | null>(null);
  const conf = confidenceLabel(item.confidence);
  const fid = `review-${item.id}`;
  return (
    <li className="space-y-3 rounded-xl border bg-card p-4 motion-safe:animate-in motion-safe:fade-in-0">
      <form
        noValidate
        className="space-y-3"
        aria-label={`Review ${item.title}`}
        onSubmit={(e) => {
          e.preventDefault();
          const err = validateTitle(title);
          setError(err);
          if (!err)
            onAccept({
              title: title.trim(),
              priority,
              ...(item.description ? { description: item.description } : {}),
            });
        }}
      >
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant={conf.low ? 'destructive' : 'secondary'}>{conf.text}</Badge>
          {/* UNTRUSTED LLM hints: shown as text, never used as identity. */}
          {item.assigneeHint ? (
            <span className="text-muted-foreground">Suggested owner: {item.assigneeHint}</span>
          ) : null}
          {item.dueHint ? <span className="text-muted-foreground">Due: {item.dueHint}</span> : null}
          <Link
            to="/meetings/$meetingId"
            params={{ meetingId: item.meetingId }}
            className="text-link underline-offset-4 hover:underline"
          >
            View meeting
          </Link>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${fid}-title`}>Title</Label>
          <Input
            className="min-h-11"
            id={`${fid}-title`}
            value={title}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${fid}-title-error` : undefined}
            onChange={(e) => setTitle(e.target.value)}
          />
          {error ? (
            <p id={`${fid}-title-error`} className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        {item.description ? (
          <p className="text-sm text-muted-foreground">{item.description}</p>
        ) : null}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1">
            <Label htmlFor={`${fid}-priority`}>Priority</Label>
            <select
              id={`${fid}-priority`}
              value={priority}
              onChange={(e) => setPriority(e.target.value as TaskPriority)}
              className="h-11 rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p[0]!.toUpperCase() + p.slice(1)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <Button
              className="min-h-11"
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onDismiss}
            >
              <X aria-hidden /> Dismiss
            </Button>
            <Button className="min-h-11" type="submit" disabled={busy}>
              <Check aria-hidden /> Accept
            </Button>
          </div>
        </div>
      </form>
    </li>
  );
});

/** /tasks/review: accept (with edits) or dismiss AI-extracted tasks. Nothing is written without a click. */
export function TaskReviewPage() {
  const review = useReviewApi();
  const organizationId = useOrganizationId();
  const qc = useQueryClient();
  const key = ['orgs', organizationId, 'extracted-tasks'] as const;
  const query = useQuery<Paginated<ExtractedTask> | null>({
    queryKey: key,
    enabled: Boolean(organizationId),
    retry: (n, err) => !(err instanceof ApiError && err.status === 404) && n < 2,
    queryFn: async () => {
      try {
        return await review.pending(organizationId);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
  });

  const removeLocal = (id: string) =>
    qc.setQueryData<Paginated<ExtractedTask> | null>(key, (old) =>
      old ? { ...old, items: old.items.filter((t) => t.id !== id) } : old,
    );

  /** 409: someone already accepted or dismissed it. Drop it locally, resync, and say so. */
  const onReviewError = (err: unknown, id: string, title: string) => {
    if (err instanceof ApiError && err.status === 409) {
      removeLocal(id);
      void qc.invalidateQueries({ queryKey: key });
      notify.info(
        'Task already reviewed',
        'Someone already accepted or dismissed this suggestion.',
      );
      return;
    }
    toastError(err, { title });
  };

  const accept = useMutation({
    mutationFn: (v: { id: string; body: AcceptExtractedTaskRequest }) =>
      review.accept(organizationId, v.id, v.body),
    onSuccess: (task, v) => {
      removeLocal(v.id);
      void qc.invalidateQueries({ queryKey: ['orgs', organizationId, 'tasks'] });
      notify.success('Task added', task.title);
    },
    onError: (err, v) => onReviewError(err, v.id, "Couldn't accept the task"),
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => review.dismiss(organizationId, id),
    onSuccess: (_, id) => {
      removeLocal(id);
      notify.info('Suggestion dismissed');
    },
    onError: (err, id) => onReviewError(err, id, "Couldn't dismiss the suggestion"),
  });
  const busyId = accept.isPending
    ? accept.variables?.id
    : dismiss.isPending
      ? dismiss.variables
      : undefined;

  let body: React.ReactNode;
  if (query.isError) body = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  else if (query.data === undefined) body = <LoadingState />;
  else if (!query.data || query.data.items.length === 0)
    body = (
      <EmptyState
        title="Nothing to review"
        description="Tasks suggested from meeting reports will appear here for approval."
      />
    );
  else
    body = (
      <ul className="space-y-3" aria-label="Suggested tasks">
        {query.data.items.map((item) => (
          <ReviewCard
            key={item.id}
            item={item}
            busy={busyId === item.id}
            onAccept={(b) => accept.mutate({ id: item.id, body: b })}
            onDismiss={() => dismiss.mutate(item.id)}
          />
        ))}
      </ul>
    );
  return (
    <>
      <PageHeader title="Review tasks" description="Approve tasks suggested from your meetings" />
      {body}
    </>
  );
}
