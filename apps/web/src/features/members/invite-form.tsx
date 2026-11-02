import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { Id } from '@meetops/contracts';
import { Button } from '@/components/ui/button';
import { SelectField } from '@/features/directory/directory-ui';
import { Field } from '@/features/auth/field';
import type { Invitation, InvitableRole } from '@/lib/api/client';
import { ApiError } from '@/lib/api/client';
import { useApi } from '@/lib/api/context';
import { notify, toastError } from '@/lib/errors/notify';
import { memberActionMessage } from './messages';
import { ROLE_LABEL } from './permissions';

/** Mirrors the API's CreateInvitationBody: email (max 320) and an invitable role. */
export const inviteSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Email is required')
    .max(320)
    .pipe(z.email('Enter a valid email address')),
  role: z.enum(['admin', 'member', 'viewer']),
});
export type InviteValues = z.infer<typeof inviteSchema>;

export function InviteForm({
  organizationId,
  roles,
  onInvited,
}: {
  organizationId: Id;
  roles: InvitableRole[];
  onInvited: (invitation: Invitation) => void;
}) {
  const api = useApi();
  const defaultRole: InvitableRole = roles.includes('member') ? 'member' : (roles[0] ?? 'viewer');
  const {
    register,
    control,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<InviteValues>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { email: '', role: defaultRole },
  });

  const onSubmit = async (values: InviteValues) => {
    try {
      const invitation = await api.invitations.create(organizationId, values);
      onInvited(invitation);
      notify.success(`Invitation sent to ${invitation.email}.`);
      reset({ email: '', role: values.role });
    } catch (err) {
      // Errors about the address (already a member, invalid, role not allowed) belong to the
      // email field; anything else (network, 5xx, 429, session) is a toast.
      if (err instanceof ApiError && [400, 403, 409, 422].includes(err.status)) {
        setError(
          'email',
          { type: 'server', message: memberActionMessage('invite', err) },
          { shouldFocus: true },
        );
        return;
      }
      toastError(err, { title: "Couldn't send invitation" });
    }
  };

  return (
    <form
      noValidate
      aria-label="Invite a member"
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => void handleSubmit(onSubmit)(e)}
    >
      <div className="min-w-64 flex-1">
        <Field
          label="Email"
          type="email"
          autoComplete="off"
          error={errors.email?.message}
          {...register('email')}
        />
      </div>
      <div className="w-40">
        <Controller
          name="role"
          control={control}
          render={({ field }) => (
            <SelectField
              label="Role"
              name="role"
              value={field.value}
              onValueChange={(v) => field.onChange(v as InvitableRole)}
              options={roles.map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
            />
          )}
        />
      </div>
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Sending…' : 'Send invite'}
      </Button>
    </form>
  );
}
