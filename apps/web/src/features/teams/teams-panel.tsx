import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/features/auth/field';
import { useApi } from '@/lib/api/context';
import {
  ConfirmDeleteButton,
  FormError,
  InfiniteList,
  SearchBox,
  TextAreaField,
} from '@/features/directory/directory-ui';
import {
  directoryKeys,
  useCanManageDirectory,
  useDirectoryMutation,
  useTeams,
} from '@/features/directory/queries';
import {
  omitEmpty,
  teamFormSchema,
  toSearchQuery,
  type TeamFormValues,
} from '@/features/directory/schemas';
import { useDebounced } from '@/features/directory/use-debounced';

export function TeamsPanel() {
  const canManage = useCanManageDirectory();
  const [search, setSearch] = useState('');
  const q = toSearchQuery(useDebounced(search));
  const teams = useTeams(q);
  const { directory } = useApi();
  const remove = useDirectoryMutation(
    (orgId, id: string) => directory.teams.remove(orgId, id),
    (orgId) => [directoryKeys.teams(orgId), directoryKeys.projects(orgId)],
  );

  return (
    <section aria-labelledby="teams-heading" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="teams-heading" className="text-lg font-semibold">
          Teams
        </h2>
        <SearchBox label="Search teams" value={search} onChange={setSearch} />
      </div>
      {canManage ? <CreateTeamForm /> : null}
      <InfiniteList
        query={teams}
        label="Teams"
        emptyTitle={q.q ? 'No matching teams' : 'No teams yet'}
        getKey={(t) => t.id}
        renderItem={(t) => (
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="flex items-center gap-2 font-medium">
                <Link
                  to="/settings/teams/$teamId"
                  params={{ teamId: t.id }}
                  className="truncate hover:underline"
                >
                  {t.name}
                </Link>
                {t.key ? <Badge variant="outline">{t.key}</Badge> : null}
              </p>
              {t.description ? (
                <p className="truncate whitespace-pre-line text-sm text-muted-foreground">
                  {t.description}
                </p>
              ) : null}
            </div>
            {canManage ? (
              <ConfirmDeleteButton label={t.name} onConfirm={() => remove.mutateAsync(t.id)} />
            ) : null}
          </div>
        )}
      />
    </section>
  );
}

const EMPTY: TeamFormValues = { name: '', key: '', description: '' };

function CreateTeamForm() {
  const { directory } = useApi();
  const create = useDirectoryMutation(
    (orgId, values: TeamFormValues) =>
      directory.teams.create(orgId, { ...omitEmpty(values), name: values.name }),
    (orgId) => [directoryKeys.teams(orgId)],
  );
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<TeamFormValues>({ resolver: zodResolver(teamFormSchema), defaultValues: EMPTY });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Create team</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          aria-label="Create team"
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
          <Field label="Team name" error={errors.name?.message} {...register('name')} />
          <Field
            label="Team key (optional)"
            autoCapitalize="characters"
            error={errors.key?.message}
            {...register('key')}
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
              {isSubmitting ? 'Creating…' : 'Create team'}
            </Button>
            <FormError
              error={create.error}
              conflict="A team with that name or key already exists."
            />
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
