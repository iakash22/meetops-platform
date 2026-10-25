import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { Id } from '@meetops/contracts';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Field } from '@/features/auth/field';
import type { Invitation, InvitableRole } from '@/lib/api/client';
import { useApi } from '@/lib/api/context';
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
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const defaultRole: InvitableRole = roles.includes('member') ? 'member' : (roles[0] ?? 'viewer');
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<InviteValues>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { email: '', role: defaultRole },
  });

  const onSubmit = async (values: InviteValues) => {
    setError(null);
    setSent(null);
    try {
      const invitation = await api.invitations.create(organizationId, values);
      onInvited(invitation);
      setSent(`Invitation sent to ${invitation.email}.`);
      reset({ email: '', role: values.role });
    } catch (err) {
      setError(memberActionMessage('invite', err));
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
      <div className="grid gap-1.5">
        <Label htmlFor="invite-role">Role</Label>
        <select
          id="invite-role"
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          {...register('role')}
        >
          {roles.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Sending…' : 'Send invite'}
      </Button>
      {error ? (
        <p role="alert" className="basis-full text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {sent ? (
        <p role="status" className="basis-full text-sm text-muted-foreground">
          {sent}
        </p>
      ) : null}
    </form>
  );
}
