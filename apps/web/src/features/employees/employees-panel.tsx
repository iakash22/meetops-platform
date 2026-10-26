import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/features/auth/field';
import { useApi } from '@/lib/api/context';
import type { EmployeeDto } from '@/features/directory/contracts-shim';
import {
  ConfirmDeleteButton,
  FormError,
  InfiniteList,
  SearchBox,
} from '@/features/directory/directory-ui';
import {
  directoryKeys,
  useCanManageDirectory,
  useDirectoryMutation,
  useEmployees,
} from '@/features/directory/queries';
import {
  employeeFormSchema,
  omitEmpty,
  toSearchQuery,
  type EmployeeFormValues,
} from '@/features/directory/schemas';
import { useDebounced } from '@/features/directory/use-debounced';

export function EmployeesPanel() {
  const canManage = useCanManageDirectory();
  const [search, setSearch] = useState('');
  const q = toSearchQuery(useDebounced(search));
  const employees = useEmployees(q);
  const { directory } = useApi();
  const remove = useDirectoryMutation(
    (orgId, id: string) => directory.employees.remove(orgId, id),
    (orgId) => [directoryKeys.employees(orgId), directoryKeys.teams(orgId)],
  );

  return (
    <section aria-labelledby="employees-heading" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="employees-heading" className="text-lg font-semibold">
          Employees
        </h2>
        <SearchBox label="Search employees" value={search} onChange={setSearch} />
      </div>
      {canManage ? <CreateEmployeeForm /> : null}
      <InfiniteList
        query={employees}
        label="Employees"
        emptyTitle={q.q ? 'No matching employees' : 'No employees yet'}
        {...(canManage && !q.q ? { emptyDescription: 'Add the people in your organization.' } : {})}
        getKey={(e) => e.id}
        renderItem={(e) => (
          <EmployeeRow
            employee={e}
            {...(canManage ? { onDelete: () => remove.mutateAsync(e.id) } : {})}
          />
        )}
      />
    </section>
  );
}

function EmployeeRow({
  employee,
  onDelete,
}: {
  employee: EmployeeDto;
  onDelete?: () => Promise<unknown>;
}) {
  const meta = [employee.title, employee.department].filter(Boolean).join(' · ');
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0">
        <p className="truncate font-medium">{employee.fullName}</p>
        {meta ? <p className="truncate text-sm text-muted-foreground">{meta}</p> : null}
        {employee.email ? (
          <p className="truncate text-sm text-muted-foreground">{employee.email}</p>
        ) : null}
      </div>
      {onDelete ? <ConfirmDeleteButton label={employee.fullName} onConfirm={onDelete} /> : null}
    </div>
  );
}

const EMPTY: EmployeeFormValues = { fullName: '', email: '', title: '', department: '' };

function CreateEmployeeForm() {
  const { directory } = useApi();
  const create = useDirectoryMutation(
    (orgId, values: EmployeeFormValues) =>
      directory.employees.create(orgId, {
        ...omitEmpty(values),
        fullName: values.fullName,
      }),
    (orgId) => [directoryKeys.employees(orgId)],
  );
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<EmployeeFormValues>({
    resolver: zodResolver(employeeFormSchema),
    defaultValues: EMPTY,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Add employee</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          aria-label="Add employee"
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
          <Field label="Full name" error={errors.fullName?.message} {...register('fullName')} />
          <Field label="Email" type="email" error={errors.email?.message} {...register('email')} />
          <Field label="Title" error={errors.title?.message} {...register('title')} />
          <Field
            label="Department"
            error={errors.department?.message}
            {...register('department')}
          />
          <div className="flex items-center gap-3 sm:col-span-2">
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Adding…' : 'Add employee'}
            </Button>
            <FormError error={create.error} />
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
