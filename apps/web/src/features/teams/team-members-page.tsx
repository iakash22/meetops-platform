import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState, LoadingState } from '@/components/states/states';
import { PageHeader } from '@/pages/resource-list';
import { useApi } from '@/lib/api/context';
import { TEAM_MEMBER_ROLES, type TeamMemberDto } from '@/features/directory/contracts-shim';
import {
  ConfirmDeleteButton,
  FormError,
  InfiniteList,
  SelectField,
} from '@/features/directory/directory-ui';
import {
  directoryKeys,
  flatItems,
  useCanManageDirectory,
  useDirectoryMutation,
  useEmployees,
  useTeam,
  useTeamMembers,
} from '@/features/directory/queries';
import { teamMemberFormSchema, type TeamMemberFormValues } from '@/features/directory/schemas';

export function TeamMembersPage({ teamId }: { teamId: string }) {
  const team = useTeam(teamId);
  const members = useTeamMembers(teamId);
  const canManage = useCanManageDirectory();
  const { directory } = useApi();
  const membersKey = (orgId: string) => [directoryKeys.teamMembers(orgId, teamId)];
  const remove = useDirectoryMutation(
    (orgId, employeeId: string) => directory.teamMembers.remove(orgId, teamId, employeeId),
    membersKey,
  );
  const setRole = useDirectoryMutation(
    (orgId, m: Pick<TeamMemberDto, 'employeeId' | 'role'>) =>
      directory.teamMembers.update(orgId, teamId, m.employeeId, { role: m.role }),
    membersKey,
  );

  if (team.isError) return <ErrorState title="Could not load team" error={team.error} />;
  if (team.isPending) return <LoadingState />;

  return (
    <div className="space-y-4">
      <Link to="/settings" search={{ tab: 'teams' }} className="text-sm hover:underline">
        ← All teams
      </Link>
      <PageHeader
        title={team.data.name}
        {...(team.data.description ? { description: team.data.description } : {})}
      />
      {canManage ? (
        <AddMemberForm
          teamId={teamId}
          existing={new Set(flatItems(members.data).map((m) => m.employeeId))}
        />
      ) : null}
      <h2 className="text-lg font-semibold">Members</h2>
      <InfiniteList
        query={members}
        label="Team members"
        emptyTitle="No members yet"
        getKey={(m) => m.employeeId}
        renderItem={(m) => (
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate font-medium">{m.employee.fullName}</span>
              <Badge variant={m.role === 'lead' ? 'default' : 'secondary'}>{m.role}</Badge>
            </div>
            {canManage ? (
              <span className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={setRole.isPending}
                  onClick={() =>
                    void setRole
                      .mutateAsync({
                        employeeId: m.employeeId,
                        role: m.role === 'lead' ? 'member' : 'lead',
                      })
                      .catch(() => undefined)
                  }
                >
                  {m.role === 'lead' ? 'Make member' : 'Make lead'}
                </Button>
                <ConfirmDeleteButton
                  label={m.employee.fullName}
                  onConfirm={() => remove.mutateAsync(m.employeeId)}
                />
              </span>
            ) : null}
          </div>
        )}
      />
      <FormError error={setRole.error} />
    </div>
  );
}

function AddMemberForm({ teamId, existing }: { teamId: string; existing: Set<string> }) {
  const { directory } = useApi();
  // First page of employees is enough for the picker until BE-3 search lands in the UI.
  const employees = useEmployees({ limit: 100 });
  const candidates = flatItems(employees.data).filter((e) => !existing.has(e.id));
  const add = useDirectoryMutation(
    (orgId, values: TeamMemberFormValues) => directory.teamMembers.add(orgId, teamId, values),
    (orgId) => [directoryKeys.teamMembers(orgId, teamId)],
  );
  const {
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<TeamMemberFormValues>({
    resolver: zodResolver(teamMemberFormSchema),
    defaultValues: { employeeId: '', role: 'member' },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Add member</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          aria-label="Add member"
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) =>
            void handleSubmit(async (values) => {
              await add.mutateAsync(values).then(
                () => reset({ employeeId: '', role: 'member' }),
                () => undefined,
              );
            })(e)
          }
        >
          <Controller
            control={control}
            name="employeeId"
            render={({ field }) => (
              <SelectField
                label="Employee"
                name={field.name}
                value={field.value}
                placeholder="Choose…"
                options={candidates.map((e) => ({ value: e.id, label: e.fullName }))}
                error={errors.employeeId?.message}
                onValueChange={field.onChange}
              />
            )}
          />
          <Controller
            control={control}
            name="role"
            render={({ field }) => (
              <SelectField
                label="Role"
                name={field.name}
                value={field.value}
                options={TEAM_MEMBER_ROLES.map((r) => ({ value: r, label: r }))}
                onValueChange={field.onChange}
              />
            )}
          />
          <div className="flex items-center gap-3 sm:col-span-2">
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Adding…' : 'Add member'}
            </Button>
            <FormError error={add.error} conflict="That employee is already in this team." />
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
