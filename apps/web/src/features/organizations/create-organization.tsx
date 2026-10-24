import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState } from '@/components/states/states';
import { Field } from '@/features/auth/field';
import { useApi } from '@/lib/api/context';
import { queryKeys } from '@/lib/api/queries';
import { useOrgStore } from '@/stores/org-store';

/** Mirrors the API's CreateOrganizationBody: name 1–200 chars. */
export const createOrganizationSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Organization name is required')
    .max(200, 'Organization name must be at most 200 characters'),
});
export type CreateOrganizationValues = z.infer<typeof createOrganizationSchema>;

export function CreateOrganizationPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<CreateOrganizationValues>({
    resolver: zodResolver(createOrganizationSchema),
    defaultValues: { name: '' },
  });

  const onSubmit = async ({ name }: CreateOrganizationValues) => {
    setError(null);
    try {
      const { organization } = await api.organizations.create({ name });
      const { organizations, setOrganizations, setCurrentOrganization } = useOrgStore.getState();
      // Server already rotated the session into the new org: make it current.
      setOrganizations(
        [...organizations.filter((o) => o.id !== organization.id), organization],
        organization.id,
      );
      // setOrganizations keeps an existing selection, so switch explicitly.
      setCurrentOrganization(organization.id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.session }),
        queryClient.invalidateQueries({ queryKey: ['orgs'] }),
      ]);
      await navigate({ to: '/' });
    } catch (err) {
      setError(err);
    }
  };

  return (
    <Card className="max-w-md">
      <CardHeader>
        <CardTitle>
          <h1>Create organization</h1>
        </CardTitle>
        <CardDescription>Organizations hold your meetings, tasks and projects.</CardDescription>
      </CardHeader>
      <CardContent>
        <form noValidate className="grid gap-4" onSubmit={(e) => void handleSubmit(onSubmit)(e)}>
          {error ? <ErrorState title="Could not create organization" error={error} /> : null}
          <Field
            label="Organization name"
            autoComplete="organization"
            error={errors.name?.message}
            {...register('name')}
          />
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Creating…' : 'Create organization'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
