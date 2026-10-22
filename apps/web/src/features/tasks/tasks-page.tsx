import { useMemo } from 'react';
import { TASK_STATUSES, type TaskStatusValue } from '@meetops/contracts/types';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import type { TaskListFilters } from '@/lib/api/client';
import { useTasks } from '@/lib/api/queries';
import { PageHeader, ResourceList } from '@/pages/resource-list';

export { TASK_STATUSES };
export type TaskDueFilter = 'overdue' | 'today' | 'week';
export const TASK_DUE = ['overdue', 'today', 'week'] as const satisfies readonly TaskDueFilter[];
/** Assignee filter values: 'me', 'unassigned', or a user id. */
export type TaskSearch = { status?: TaskStatusValue; assignee?: string; due?: TaskDueFilter };

const STATUS_LABEL: Record<TaskStatusValue, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
};
const DUE_LABEL: Record<TaskDueFilter, string> = {
  overdue: 'Overdue',
  today: 'Due today',
  week: 'Due this week',
};

/** Parse untrusted URL search params into known filter values only. */
export function parseTaskSearch(search: Record<string, unknown>): TaskSearch {
  const out: TaskSearch = {};
  if (
    typeof search.status === 'string' &&
    (TASK_STATUSES as readonly string[]).includes(search.status)
  )
    out.status = search.status as TaskStatusValue;
  if (typeof search.assignee === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(search.assignee))
    out.assignee = search.assignee;
  if (typeof search.due === 'string' && (TASK_DUE as readonly string[]).includes(search.due))
    out.due = search.due as TaskDueFilter;
  return out;
}

/**
 * Due filter → dueAfter/dueBefore (ISO, UTC) computed in the user's local time zone.
 * overdue: before now. today: local start..end of today. week: now..end of Sunday
 * (weeks start Monday, so Sunday is the last day).
 */
export function dueRange(
  due: TaskDueFilter,
  now: Date = new Date(),
): { dueAfter?: string; dueBefore?: string } {
  const endOfDay = (d: Date) => {
    const e = new Date(d);
    e.setHours(23, 59, 59, 999);
    return e;
  };
  if (due === 'overdue') return { dueBefore: now.toISOString() };
  if (due === 'today') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { dueAfter: start.toISOString(), dueBefore: endOfDay(now).toISOString() };
  }
  const daysToSunday = (7 - now.getDay()) % 7; // getDay: 0 = Sunday
  const sunday = new Date(now);
  sunday.setDate(now.getDate() + daysToSunday);
  return { dueAfter: now.toISOString(), dueBefore: endOfDay(sunday).toISOString() };
}

export function toApiFilters(
  search: TaskSearch,
  currentUserId?: string,
  now: Date = new Date(),
): TaskListFilters {
  const base: { status?: TaskStatusValue; dueAfter?: string; dueBefore?: string } = {};
  if (search.status) base.status = search.status;
  if (search.due) Object.assign(base, dueRange(search.due, now));
  if (search.assignee === 'unassigned') return { ...base, unassigned: true };
  const assigneeId = search.assignee === 'me' ? currentUserId : search.assignee;
  return assigneeId ? { ...base, assigneeId } : base;
}

function FilterSelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string | undefined;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (v: string | undefined) => void;
}) {
  return (
    <div className="grid gap-1">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
      >
        <option value="">All</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function TasksPage({
  search,
  currentUserId,
  onSearchChange,
}: {
  search: TaskSearch;
  currentUserId?: string;
  onSearchChange: (next: TaskSearch) => void;
}) {
  // Freeze "now" per filter selection so the query key is stable across renders.
  const filters = useMemo(() => toApiFilters(search, currentUserId), [search, currentUserId]);
  const query = useTasks(filters);
  const set = (patch: { [K in keyof TaskSearch]?: TaskSearch[K] | undefined }) => {
    const merged = { ...search, ...patch };
    const next: TaskSearch = {};
    if (merged.status) next.status = merged.status;
    if (merged.assignee) next.assignee = merged.assignee;
    if (merged.due) next.due = merged.due;
    onSearchChange(next);
  };
  return (
    <>
      <PageHeader title="Tasks" />
      <div className="mb-4 flex flex-wrap gap-4" role="group" aria-label="Task filters">
        <FilterSelect
          id="filter-status"
          label="Status"
          value={search.status}
          options={TASK_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
          onChange={(v) => set({ status: v as TaskStatusValue | undefined })}
        />
        <FilterSelect
          id="filter-assignee"
          label="Assignee"
          value={search.assignee}
          options={[
            { value: 'me', label: 'Me' },
            { value: 'unassigned', label: 'Unassigned' },
          ]}
          onChange={(v) => set({ assignee: v })}
        />
        <FilterSelect
          id="filter-due"
          label="Due"
          value={search.due}
          options={TASK_DUE.map((d) => ({ value: d, label: DUE_LABEL[d] }))}
          onChange={(v) => set({ due: v as TaskDueFilter | undefined })}
        />
      </div>
      <ResourceList
        query={query}
        emptyTitle="No tasks match"
        renderItem={(t) => (
          <div className="flex items-center justify-between gap-4">
            {/* Plain text only: titles may come from AI/realtime and are untrusted. */}
            <span data-testid="task-title">{t.title}</span>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>{t.priority}</span>
              <Badge variant="secondary">{STATUS_LABEL[t.status]}</Badge>
            </div>
          </div>
        )}
      />
    </>
  );
}
