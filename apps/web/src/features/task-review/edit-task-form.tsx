import { useId, useState } from 'react';
import type { Task, TaskPriority, TaskStatus } from '@meetops/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/api/client';
import type { UpdateTaskRequest } from './api';

export const PRIORITIES: readonly TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
export const STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'done', 'cancelled'];
const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
};
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

export type EditValues = {
  title: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  /** `YYYY-MM-DD` from <input type="date">, or '' for no due date. */
  due: string;
};
export type EditField = 'title' | 'description' | 'dueAt';
export type FieldErrors = Partial<Record<EditField, string>>;

export function toEditValues(t: Task): EditValues {
  return {
    title: t.title,
    description: t.description ?? '',
    priority: t.priority,
    status: t.status,
    due: t.dueAt ? t.dueAt.slice(0, 10) : '',
  };
}

/** Client-side checks mirroring UpdateTaskRequest (title 1–500, description ≤ 10,000). */
export function validateEdit(v: EditValues): FieldErrors {
  const e: FieldErrors = {};
  const title = v.title.trim();
  if (!title) e.title = 'Enter a title.';
  else if (title.length > 500) e.title = 'Keep the title under 500 characters.';
  if (v.description.length > 10_000)
    e.description = 'Keep the description under 10,000 characters.';
  if (v.due && Number.isNaN(Date.parse(`${v.due}T00:00:00Z`))) e.dueAt = 'Enter a valid date.';
  return e;
}

/** Only the changed keys; '' clears description/dueAt with `null`. Empty object means nothing changed. */
export function buildUpdate(task: Task, v: EditValues): UpdateTaskRequest {
  const before = toEditValues(task);
  const body: UpdateTaskRequest = {};
  const title = v.title.trim();
  if (title !== before.title) body.title = title;
  if (v.description !== before.description)
    body.description = v.description.trim() ? v.description : null;
  if (v.priority !== before.priority) body.priority = v.priority;
  if (v.status !== before.status) body.status = v.status;
  if (v.due !== before.due) body.dueAt = v.due ? `${v.due}T00:00:00.000Z` : null;
  return body;
}

/** Server 400/422 details on a known field -> inline errors; anything else returns null (toast it). */
export function serverFieldErrors(err: unknown): FieldErrors | null {
  if (!(err instanceof ApiError) || (err.status !== 400 && err.status !== 422)) return null;
  const out: FieldErrors = {};
  const copy: Record<EditField, string> = {
    title: 'Enter a valid title.',
    description: "This description isn't valid.",
    dueAt: 'Enter a valid date.',
  };
  for (const d of err.details) {
    const k = d.path.replace(/^\//, '').split('/')[0] as EditField;
    if (k in copy) out[k] = copy[k];
  }
  return Object.keys(out).length ? out : null;
}

const selectClass =
  'h-11 w-full rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function EditTaskForm({
  task,
  busy,
  errors,
  onSubmit,
  onCancel,
}: {
  task: Task;
  busy: boolean;
  errors: FieldErrors;
  onSubmit: (values: EditValues, clientErrors: FieldErrors) => void;
  onCancel: () => void;
}) {
  const uid = useId();
  const [v, setV] = useState<EditValues>(() => toEditValues(task));
  const set = <K extends keyof EditValues>(k: K, val: EditValues[K]) =>
    setV((old) => ({ ...old, [k]: val }));
  const err = (f: EditField) =>
    errors[f] ? (
      <p id={`${uid}-${f}-error`} className="text-sm text-destructive">
        {errors[f]}
      </p>
    ) : null;
  const a11y = (f: EditField) => ({
    'aria-invalid': errors[f] ? true : undefined,
    'aria-describedby': errors[f] ? `${uid}-${f}-error` : undefined,
  });
  return (
    <form
      noValidate
      aria-label="Edit task"
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(v, validateEdit(v));
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor={`${uid}-title`}>Title</Label>
        <Input
          id={`${uid}-title`}
          className="h-11"
          value={v.title}
          maxLength={600}
          onChange={(e) => set('title', e.target.value)}
          {...a11y('title')}
        />
        {err('title')}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${uid}-description`}>Description</Label>
        <Textarea
          id={`${uid}-description`}
          rows={4}
          value={v.description}
          onChange={(e) => set('description', e.target.value)}
          {...a11y('description')}
        />
        {err('description')}
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor={`${uid}-priority`}>Priority</Label>
          <select
            id={`${uid}-priority`}
            className={selectClass}
            value={v.priority}
            onChange={(e) => set('priority', e.target.value as TaskPriority)}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {cap(p)}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${uid}-status`}>Status</Label>
          <select
            id={`${uid}-status`}
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
        <div className="grid gap-1.5">
          <Label htmlFor={`${uid}-due`}>Due date</Label>
          <Input
            id={`${uid}-due`}
            type="date"
            className="h-11"
            value={v.due}
            onChange={(e) => set('due', e.target.value)}
            {...a11y('dueAt')}
          />
          {err('dueAt')}
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" className="min-h-11" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" className="min-h-11" disabled={busy}>
          {busy ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}
