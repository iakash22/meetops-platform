import type { Task, TaskPriority, TaskStatus } from '@meetops/contracts';

import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useDataSource } from '@/features/data/repositories';
import { ListError, ListLoading } from '@/features/data/list-states';
import { useOrgList } from '@/features/data/use-org-list';

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
};

const STATUS_VARIANT: Record<TaskStatus, NonNullable<BadgeProps['variant']>> = {
  todo: 'outline',
  in_progress: 'default',
  done: 'secondary',
  cancelled: 'secondary',
};

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};

function due(iso: string | undefined): string {
  return iso
    ? `Due ${new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' })}`
    : 'No due date';
}

export function TasksScreen() {
  const data = useDataSource();
  const { state, retry } = useOrgList(data.listTasks);
  const tasks: readonly Task[] = state.status === 'ready' ? state.items : [];
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
        <p className="text-sm text-muted-foreground">
          {data.sample ? 'Sample data.' : 'Tasks in your active organization.'}
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Open and recent tasks</CardTitle>
          <CardDescription>
            {state.status === 'ready' ? `${tasks.length} tasks` : '\u00a0'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {state.status === 'loading' ? (
            <ListLoading label="tasks" />
          ) : state.status === 'error' ? (
            <ListError message={state.message} onRetry={retry} />
          ) : tasks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tasks yet.</p>
          ) : (
            <ul aria-label="Tasks" className="divide-y divide-border">
              {tasks.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{t.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {PRIORITY_LABEL[t.priority]} priority · {due(t.dueAt)}
                    </p>
                  </div>
                  <Badge variant={STATUS_VARIANT[t.status]}>{STATUS_LABEL[t.status]}</Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
