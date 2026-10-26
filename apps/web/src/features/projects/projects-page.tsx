import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/features/auth/field';
import { PageHeader } from '@/pages/resource-list';
import { useApi } from '@/lib/api/context';
import {
  PROJECT_STATUSES,
  type ProjectDto,
  type ProjectStatus,
  type TeamDto,
} from '@/features/directory/contracts-shim';
import {
  ConfirmDeleteButton,
  FormError,
  InfiniteList,
  SearchBox,
  SelectField,
  TextAreaField,
} from '@/features/directory/directory-ui';
import {
  directoryKeys,
  flatItems,
  useCanManageDirectory,
  useDirectoryMutation,
  useProjectList,
  useTeams,
} from '@/features/directory/queries';
import {
  omitEmpty,
  projectFormSchema,
  projectStatusSchema,
  toSearchQuery,
  type ProjectFormValues,
} from '@/features/directory/schemas';
import { useDebounced } from '@/features/directory/use-debounced';

export function ProjectsPage() {
  const canManage = useCanManageDirectory();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<ProjectStatus | ''>('active');
  const q = { ...toSearchQuery(useDebounced(search)), ...(status ? { status } : {}) };
  const projects = useProjectList(q);
  // Team names for the list and the create form (first page; teams are few per org).
  const teams = flatItems(useTeams({ limit: 100 }).data);
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const { directory } = useApi();
  const update = useDirectoryMutation(
    (orgId, v: { id: string; status: ProjectStatus }) =>
      directory.projects.update(orgId, v.id, { status: v.status }),
    (orgId) => [directoryKeys.projects(orgId)],
  );
  const remove = useDirectoryMutation(
    (orgId, id: string) => directory.projects.remove(orgId, id),
    (orgId) => [directoryKeys.projects(orgId)],
  );

  return (
    <div className="space-y-4">
      <PageHeader title="Projects" description="Work grouped by project and team" />
      {canManage ? <CreateProjectForm teams={teams} /> : null}
      <div className="flex flex-wrap items-end gap-3">
        <SearchBox label="Search projects" value={search} onChange={setSearch} />
        <div className="w-40">
          <SelectField
            label="Status"
            name="statusFilter"
            value={status}
            emptyLabel="All"
            options={PROJECT_STATUSES.map((s) => ({ value: s, label: s }))}
            onValueChange={(v) => {
              const parsed = projectStatusSchema.safeParse(v);
              setStatus(parsed.success ? parsed.data : '');
            }}
          />
        </div>
      </div>
      <InfiniteList
        query={projects}
        label="Projects"
        emptyTitle={q.q || q.status ? 'No matching projects' : 'No projects yet'}
        getKey={(p) => p.id}
        renderItem={(p) => (
          <ProjectRow
            project={p}
            teamName={p.teamId ? teamName.get(p.teamId) : undefined}
            {...(canManage
              ? {
                  onToggleArchive: () =>
                    update.mutateAsync({
                      id: p.id,
                      status: p.status === 'active' ? 'archived' : 'active',
                    }),
                  onDelete: () => remove.mutateAsync(p.id),
                }
              : {})}
          />
        )}
      />
      <FormError error={update.error} />
    </div>
  );
}

function ProjectRow({
  project,
  teamName,
  onToggleArchive,
  onDelete,
}: {
  project: ProjectDto;
  teamName: string | undefined;
  onToggleArchive?: () => Promise<unknown>;
  onDelete?: () => Promise<unknown>;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0">
        <p className="flex items-center gap-2 font-medium">
          <span className="truncate">{project.name}</span>
          <Badge variant="outline">{project.key}</Badge>
          <Badge variant={project.status === 'active' ? 'secondary' : 'outline'}>
            {project.status}
          </Badge>
        </p>
        {teamName ? <p className="text-sm text-muted-foreground">Team: {teamName}</p> : null}
        {project.description ? (
          <p className="truncate whitespace-pre-line text-sm text-muted-foreground">
            {project.description}
          </p>
        ) : null}
      </div>
      {onToggleArchive && onDelete ? (
        <span className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label={`${project.status === 'active' ? 'Archive' : 'Restore'} ${project.name}`}
            onClick={() => void onToggleArchive().catch(() => undefined)}
          >
            {project.status === 'active' ? 'Archive' : 'Restore'}
          </Button>
          <ConfirmDeleteButton label={project.name} onConfirm={onDelete} />
        </span>
      ) : null}
    </div>
  );
}

const EMPTY: ProjectFormValues = { name: '', key: '', description: '', teamId: '' };

function CreateProjectForm({ teams }: { teams: TeamDto[] }) {
  const { directory } = useApi();
  const create = useDirectoryMutation(
    (orgId, values: ProjectFormValues) =>
      directory.projects.create(orgId, {
        ...omitEmpty(values),
        name: values.name,
        key: values.key,
      }),
    (orgId) => [directoryKeys.projects(orgId)],
  );
  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ProjectFormValues>({
    resolver: zodResolver(projectFormSchema),
    defaultValues: EMPTY,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">New project</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          aria-label="New project"
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) =>
            void handleSubmit(async (values) => {
              await create.mutateAsync(values).then(
                () => reset(EMPTY),
                () => undefined,
              );
            })(e)
          }
        >
          <Field label="Project name" error={errors.name?.message} {...register('name')} />
          <Field
            label="Project key"
            autoCapitalize="characters"
            error={errors.key?.message}
            {...register('key')}
          />
          <Controller
            control={control}
            name="teamId"
            render={({ field }) => (
              <SelectField
                label="Team (optional)"
                name={field.name}
                value={field.value}
                emptyLabel="No team"
                options={teams.map((t) => ({ value: t.id, label: t.name }))}
                onValueChange={field.onChange}
              />
            )}
          />
          <div className="sm:col-span-2">
            <TextAreaField
              label="Description (optional)"
              error={errors.description?.message}
              {...register('description')}
            />
          </div>
          <div className="flex items-center gap-3 sm:col-span-2">
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Creating…' : 'Create project'}
            </Button>
            <FormError error={create.error} conflict="That project key is already in use." />
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
