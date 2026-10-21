import type { Task } from '@meetops/contracts';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import type { TaskDueFilter, TaskListFilters } from '@/lib/api/client';
import { useTasks } from '@/lib/api/queries';
import { PageHeader, ResourceList } from '@/pages/resource-list';

export const TASK_STATUSES = [
  'todo',
  'in_progress',
  'done',
  'cancelled',
] as const satisfies readonly Task['status'][];
export const TASK_DUE = ['overdue', 'today', 'week'] as const satisfies readonly TaskDueFilter[];
/** Assignee filter values: 'me', 'unassigned', or a user id. */
export type TaskSearch = { status?: Task['status']; assignee?: string; due?: TaskDueFilter };

const STATUS_LABEL: Record<Task['status'], string> = {
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
    out.status = search.status as Task['status'];
  if (typeof search.assignee === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(search.assignee))
    out.assignee = search.assignee;
  if (typeof search.due === 'string' && (TASK_DUE as readonly string[]).includes(search.due))
    out.due = search.due as TaskDueFilter;
  return out;
}

export function toApiFilters(search: TaskSearch, currentUserId?: string): TaskListFilters {
  const f: TaskListFilters = {};
  if (search.status) f.status = search.status;
  if (search.due) f.due = search.due;
  if (search.assignee === 'me') {
    if (currentUserId) f.assigneeId = currentUserId;
  } else if (search.assignee) f.assigneeId = search.assignee;
  return f;
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
  const query = useTasks(toApiFilters(search, currentUserId));
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
          onChange={(v) => set({ status: v as Task['status'] | undefined })}
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
