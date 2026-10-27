import { useCallback, useEffect, useId, useState } from 'react';
import type { ExtractedTask, Task, TaskPriority, TaskStatus } from '@meetops/contracts';
import { Check, Pencil, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Toast } from '@/components/ui/toast';
import { AuthError } from '@/features/auth/auth-client';
import { useSession } from '@/features/auth/session';
import { useDataSource } from '@/features/data/repositories';
import { ListError, ListLoading } from '@/features/data/list-states';
import {
  PRIORITIES,
  PRIORITY_LABEL,
  STATUSES,
  STATUS_LABEL,
  buildUpdate,
  toEditValues,
  validateEdit,
  type EditValues,
  type FieldErrors,
} from './task-review-core';

const selectClass =
  'h-11 w-full rounded-md border border-input bg-background px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

const code = (e: unknown) => (e instanceof AuthError ? e.code : 'INTERNAL');
const message = (e: unknown, fallback: string) =>
  e instanceof AuthError && e.message ? e.message : fallback;

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; items: ExtractedTask[] };

/** Phase 4: accept (with title/priority edits) or dismiss AI-extracted tasks, then edit what was accepted. */
export function TaskReviewPanel() {
  const { review } = useDataSource();
  const org = useSession().session?.activeOrganizationId ?? '';
  const [state, setState] = useState<State>({ status: 'loading' });
  const [accepted, setAccepted] = useState<Task[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!org) return;
    setState({ status: 'loading' });
    review.pending(org).then(
      (p) => setState({ status: 'ready', items: p.items }),
      (e) =>
        code(e) === 'NOT_FOUND'
          ? setState({ status: 'ready', items: [] })
          : setState({ status: 'error', message: message(e, "Couldn't load suggestions.") }),
    );
  }, [org, review]);
  useEffect(load, [load]);

  const drop = (id: string) =>
    setState((s) =>
      s.status === 'ready' ? { ...s, items: s.items.filter((i) => i.id !== id) } : s,
    );
  const onReviewError = (e: unknown, id: string, what: string) => {
    if (code(e) === 'CONFLICT') {
      drop(id);
      setToast('Task already reviewed: someone already accepted or dismissed it.');
    } else setToast(message(e, `Couldn't ${what}.`));
  };

  const accept = async (item: ExtractedTask, title: string, priority: TaskPriority) => {
    setBusy(item.id);
    try {
      const t = await review.accept(org, item.id, { title, priority });
      drop(item.id);
      setAccepted((a) => [t, ...a.filter((x) => x.id !== t.id)].slice(0, 20));
    } catch (e) {
      onReviewError(e, item.id, 'accept the task');
    } finally {
      setBusy(null);
    }
  };
  const dismiss = async (item: ExtractedTask) => {
    setBusy(item.id);
    try {
      await review.dismiss(org, item.id);
      drop(item.id);
    } catch (e) {
      onReviewError(e, item.id, 'dismiss the suggestion');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Review suggested tasks</h2>
        </CardTitle>
        <CardDescription>Approve tasks suggested from your meetings.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {state.status === 'loading' ? (
          <ListLoading label="suggestions" />
        ) : state.status === 'error' ? (
          <ListError message={state.message} onRetry={load} />
        ) : state.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing to review.</p>
        ) : (
          <ul aria-label="Suggested tasks" className="space-y-3">
            {state.items.map((i) => (
              <ReviewRow
                key={i.id}
                item={i}
                busy={busy === i.id}
                onAccept={(t, p) => void accept(i, t, p)}
                onDismiss={() => void dismiss(i)}
              />
            ))}
          </ul>
        )}
        {accepted.length ? (
          <section aria-labelledby="accepted-h" className="space-y-2">
            <h3 id="accepted-h" className="text-sm font-semibold">
              Accepted just now
            </h3>
            <ul aria-label="Accepted tasks" className="space-y-2">
              {accepted.map((t) =>
                editing === t.id ? (
                  <li key={t.id}>
                    <EditTaskForm
                      task={t}
                      org={org}
                      onDone={(next, note) => {
                        if (next) setAccepted((a) => a.map((x) => (x.id === next.id ? next : x)));
                        if (note) setToast(note);
                        setEditing(null);
                      }}
                      onToast={setToast}
                    />
                  </li>
                ) : (
                  <li
                    key={t.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{t.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {PRIORITY_LABEL[t.priority]} · {STATUS_LABEL[t.status]}
                        {t.dueAt ? ` · due ${t.dueAt.slice(0, 10)}` : ''}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      className="min-h-11"
                      aria-label={`Edit ${t.title}`}
                      onClick={() => setEditing(t.id)}
                    >
                      <Pencil aria-hidden /> Edit
                    </Button>
                  </li>
                ),
              )}
            </ul>
          </section>
        ) : null}
        <Toast message={toast} onDismiss={() => setToast(null)} />
      </CardContent>
    </Card>
  );
}

function ReviewRow({
  item,
  busy,
  onAccept,
  onDismiss,
}: {
  item: ExtractedTask;
  busy: boolean;
  onAccept: (title: string, priority: TaskPriority) => void;
  onDismiss: () => void;
}) {
  const uid = useId();
  const [title, setTitle] = useState(item.title);
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="space-y-3 rounded-lg border border-border p-3">
      <form
        noValidate
        aria-label={`Review ${item.title}`}
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          const t = title.trim();
          if (!t || t.length > 500) {
            setError(!t ? 'Enter a title.' : 'Keep the title under 500 characters.');
            return;
          }
          onAccept(t, priority);
        }}
      >
        {item.assigneeHint ? (
          <p className="text-xs text-muted-foreground">Suggested for: {item.assigneeHint}</p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
          <div className="space-y-1">
            <Label htmlFor={`${uid}-t`}>Title</Label>
            <Input
              id={`${uid}-t`}
              value={title}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${uid}-te` : undefined}
              onChange={(e) => {
                setTitle(e.target.value);
                setError(null);
              }}
            />
            {error ? (
              <p id={`${uid}-te`} className="text-sm text-destructive-text">
                {error}
              </p>
            ) : null}
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${uid}-p`}>Priority</Label>
            <select
              id={`${uid}-p`}
              className={selectClass}
              value={priority}
              onChange={(e) => setPriority(e.target.value as TaskPriority)}
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex gap-2">
          <Button type="submit" className="min-h-11" disabled={busy}>
            <Check aria-hidden /> Accept
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={busy}
            onClick={onDismiss}
          >
            <X aria-hidden /> Dismiss
          </Button>
        </div>
      </form>
    </li>
  );
}

function EditTaskForm({
  task,
  org,
  onDone,
  onToast,
}: {
  task: Task;
  org: string;
  onDone: (next: Task | null, note?: string) => void;
  onToast: (m: string) => void;
}) {
  const { review } = useDataSource();
  const uid = useId();
  const [v, setV] = useState<EditValues>(() => toEditValues(task));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof EditValues>(k: K, val: EditValues[K]) => {
    setV((o) => ({ ...o, [k]: val }));
    setErrors((e) => {
      const next = { ...e };
      delete next[k === 'due' ? 'dueAt' : (k as keyof FieldErrors)];
      delete next.form;
      return next;
    });
  };
  const err = (k: keyof FieldErrors) =>
    errors[k] ? (
      <p id={`${uid}-${k}-e`} className="text-sm text-destructive-text">
        {errors[k]}
      </p>
    ) : null;
  const a11y = (k: keyof FieldErrors) =>
    errors[k] ? { 'aria-invalid': true as const, 'aria-describedby': `${uid}-${k}-e` } : {};

  const submit = async () => {
    const client = validateEdit(v);
    setErrors(client);
    if (Object.keys(client).length) return;
    const body = buildUpdate(task, v);
    if (!Object.keys(body).length) return onDone(null);
    setSaving(true);
    try {
      onDone(await review.update(org, task.id, body));
    } catch (ex) {
      const c = code(ex);
      // api_request carries the code but not field paths, so a validation failure stays inline on the form.
      if (c === 'VALIDATION_FAILED' || c === 'BAD_REQUEST')
        setErrors({ form: message(ex, 'Check the fields and try again.') });
      else if (c === 'NOT_FOUND') onDone(null, "Couldn't update the task: it was deleted.");
      else onToast(message(ex, "Couldn't update the task."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      noValidate
      aria-label="Edit task"
      className="space-y-3 rounded-lg border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="space-y-1">
        <Label htmlFor={`${uid}-title`}>Title</Label>
        <Input
          id={`${uid}-title`}
          value={v.title}
          onChange={(e) => set('title', e.target.value)}
          {...a11y('title')}
        />
        {err('title')}
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${uid}-desc`}>Description</Label>
        <textarea
          id={`${uid}-desc`}
          className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={v.description}
          onChange={(e) => set('description', e.target.value)}
          {...a11y('description')}
        />
        {err('description')}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor={`${uid}-pr`}>Priority</Label>
          <select
            id={`${uid}-pr`}
            className={selectClass}
            value={v.priority}
            onChange={(e) => set('priority', e.target.value as TaskPriority)}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${uid}-st`}>Status</Label>
          <select
            id={`${uid}-st`}
            className={selectClass}
            value={v.status}
            onChange={(e) => set('status', e.target.value as TaskStatus)}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${uid}-due`}>Due date</Label>
          <Input
            id={`${uid}-due`}
            type="date"
            value={v.due}
            onChange={(e) => set('due', e.target.value)}
            {...a11y('dueAt')}
          />
          {err('dueAt')}
        </div>
      </div>
      {errors.form ? (
        <p role="alert" className="text-sm text-destructive-text">
          {errors.form}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" className="min-h-11" disabled={saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={saving}
          onClick={() => onDone(null)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
