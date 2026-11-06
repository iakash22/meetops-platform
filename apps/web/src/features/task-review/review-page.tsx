import { lazy, memo, Suspense, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Check, Pencil, X } from 'lucide-react';
import type { ExtractedTask, Paginated, Task, TaskPriority } from '@meetops/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SelectField } from '@/features/directory/directory-ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState, ErrorState, LoadingState } from '@/components/states/states';
import { ApiError } from '@/lib/api/client';
import { useApi } from '@/lib/api/context';
import { useOrganizationId } from '@/lib/api/queries';
import { notify, toastError } from '@/lib/errors/notify';
import { PageHeader } from '@/pages/resource-list';
import { createTaskReviewApi, type AcceptExtractedTaskRequest } from './api';
import type { EditValues, FieldErrors } from './edit-task-form';

// The edit form only loads when a reviewer opens it.
const EditTaskForm = lazy(() =>
  import('./edit-task-form').then((m) => ({ default: m.EditTaskForm })),
);

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
  serverTitleError,
}: {
  item: ExtractedTask;
  onAccept: (body: AcceptExtractedTaskRequest) => void;
  onDismiss: () => void;
  busy: boolean;
  serverTitleError?: string | null;
}) {
  const [title, setTitle] = useState(item.title);
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [localError, setError] = useState<string | null>(null);
  const error = localError ?? serverTitleError ?? null;
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
          <div className="w-40">
            <SelectField
              label="Priority"
              name={`${fid}-priority`}
              value={priority}
              onValueChange={(p) => setPriority(p as TaskPriority)}
              options={PRIORITIES.map((p) => ({
                value: p,
                label: p[0]!.toUpperCase() + p.slice(1),
              }))}
            />
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

/** /tasks/review: accept (with edits) or dismiss AI-extracted tasks, then edit what was accepted. */
export function TaskReviewPage() {
  const review = useReviewApi();
  const organizationId = useOrganizationId();
  const qc = useQueryClient();
  const key = ['orgs', organizationId, 'extracted-tasks'] as const;
  const [accepted, setAccepted] = useState<Task[]>([]);
  const [editing, setEditing] = useState<Task | null>(null);
  const [editErrors, setEditErrors] = useState<FieldErrors>({});
  const [acceptErrors, setAcceptErrors] = useState<Record<string, string>>({});
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
    if (
      err instanceof ApiError &&
      (err.status === 400 || err.status === 422) &&
      err.details.some((d) => d.path.startsWith('/title'))
    ) {
      setAcceptErrors((m) => ({ ...m, [id]: 'Enter a valid title.' }));
      return;
    }
    toastError(err, { title });
  };

  const accept = useMutation({
    mutationFn: (v: { id: string; body: AcceptExtractedTaskRequest }) =>
      review.accept(organizationId, v.id, v.body),
    onMutate: (v) =>
      setAcceptErrors((m) => {
        const next = { ...m };
        delete next[v.id];
        return next;
      }),
    onSuccess: (task, v) => {
      removeLocal(v.id);
      setAccepted((list) => [task, ...list.filter((t) => t.id !== task.id)].slice(0, 20));
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
  const update = useMutation({
    mutationFn: (v: { task: Task; body: Parameters<typeof review.update>[2] }) =>
      review.update(organizationId, v.task.id, v.body),
    onSuccess: (task) => {
      setAccepted((list) => list.map((t) => (t.id === task.id ? task : t)));
      void qc.invalidateQueries({ queryKey: ['orgs', organizationId, 'tasks'] });
      setEditing(null);
      notify.success('Task updated', task.title);
    },
    onError: async (err) => {
      const { serverFieldErrors } = await import('./edit-task-form');
      const fields = serverFieldErrors(err);
      if (fields) setEditErrors(fields);
      else if (err instanceof ApiError && err.status === 404) {
        setEditing(null);
        notify.error("Couldn't update the task", 'It was deleted or moved.');
      } else toastError(err, { title: "Couldn't update the task" });
    },
  });

  const submitEdit = async (task: Task, values: EditValues, clientErrors: FieldErrors) => {
    setEditErrors(clientErrors);
    if (Object.keys(clientErrors).length) return;
    const { buildUpdate } = await import('./edit-task-form');
    const body = buildUpdate(task, values);
    if (Object.keys(body).length === 0) {
      setEditing(null);
      notify.info('No changes to save');
      return;
    }
    update.mutate({ task, body });
  };

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
            serverTitleError={acceptErrors[item.id] ?? null}
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
      {accepted.length > 0 ? (
        <section aria-labelledby="accepted-heading" className="mt-8 space-y-3">
          <h2 id="accepted-heading" className="text-lg font-semibold">
            Accepted just now
          </h2>
          <ul className="space-y-2" aria-label="Accepted tasks">
            {accepted.map((t) => (
              <li
                key={t.id}
                className="flex items-center justify-between gap-3 rounded-xl border bg-card p-3"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{t.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {[t.priority, t.status?.replace('_', ' ')].filter(Boolean).join(' · ')}
                    {t.dueAt ? ` · due ${t.dueAt.slice(0, 10)}` : ''}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  aria-label={`Edit ${t.title}`}
                  onClick={() => {
                    setEditErrors({});
                    setEditing(t);
                  }}
                >
                  <Pencil aria-hidden /> Edit
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <Dialog open={editing !== null} onOpenChange={(o) => (o ? null : setEditing(null))}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit task</DialogTitle>
            <DialogDescription>Only the fields you change are saved.</DialogDescription>
          </DialogHeader>
          {editing ? (
            <Suspense fallback={<LoadingState label="Loading editor…" />}>
              <EditTaskForm
                key={editing.id}
                task={editing}
                busy={update.isPending}
                errors={editErrors}
                onCancel={() => setEditing(null)}
                onSubmit={(v, e) => void submitEdit(editing, v, e)}
              />
            </Suspense>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
