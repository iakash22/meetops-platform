import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Id, OrganizationMember, Role } from '@meetops/contracts';
import { EmptyState, ErrorState, LoadingState } from '@/components/states/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useSession } from '@/features/session/use-session';
import { ApiError, type Invitation } from '@/lib/api/client';
import { useApi } from '@/lib/api/context';
import { queryKeys } from '@/lib/api/queries';
import { PageHeader } from '@/pages/resource-list';
import { InviteForm } from './invite-form';
import { notify } from '@/lib/errors/notify';
import { memberActionMessage } from './messages';
import {
  assignableRoles,
  canManageMembers,
  canRemove,
  invitableRoles,
  ROLE_LABEL,
} from './permissions';
import { memberKeys, useMembers } from './queries';

function NotFound() {
  return (
    <EmptyState
      title="Organization not found"
      description="It doesn't exist or you're not a member of it."
    />
  );
}

/**
 * /organization/members: members of `organizationId` (the active org unless the
 * route got a valid `?org=`). Everyone in the org can see the list; owners/admins
 * also get invite, resend/revoke, role change and remove, per the API's CASL rules.
 * An org the caller doesn't belong to is a 404 from the API and renders as not found.
 */
export function MembersPage({
  organizationId,
  invalidOrganization = false,
}: {
  organizationId: Id | undefined;
  invalidOrganization?: boolean | undefined;
}) {
  return (
    <>
      <PageHeader title="Members" description="People in this organization and their roles" />
      {invalidOrganization ? (
        <NotFound />
      ) : !organizationId ? (
        <EmptyState
          title="You don't belong to an organization yet"
          description="Create or join one to manage members."
        />
      ) : (
        // Keyed so per-org local state (sent invitations, notices) never leaks across orgs.
        <MembersForOrganization key={organizationId} organizationId={organizationId} />
      )}
    </>
  );
}

function MembersForOrganization({ organizationId }: { organizationId: Id }) {
  const { data: session } = useSession();
  const query = useMembers(organizationId);
  // The API has no "list invitations" route: track the ones sent from this page.
  const [invitations, setInvitations] = useState<Invitation[]>([]);

  if (query.isError) {
    if (query.error instanceof ApiError && query.error.status === 404) return <NotFound />;
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }
  if (query.isPending || !session) return <LoadingState label="Loading members…" />;

  const me = query.data.items.find((m) => m.userId === session.user.id);
  const myRole = me?.role ?? null;
  const manage = canManageMembers(myRole);

  const upsertInvitation = (inv: Invitation) =>
    setInvitations((list) => [inv, ...list.filter((x) => x.email !== inv.email)]);

  return (
    <div className="grid max-w-4xl gap-6">
      {manage && myRole ? (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Invite people</h2>
            </CardTitle>
            <CardDescription>
              We&apos;ll email them a link to join. Inviting the same address again resends it.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <InviteForm
              organizationId={organizationId}
              roles={invitableRoles(myRole)}
              onInvited={upsertInvitation}
            />
            {invitations.length > 0 ? (
              <SentInvitations
                organizationId={organizationId}
                invitations={invitations}
                onChange={upsertInvitation}
              />
            ) : null}
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Members</h2>
          </CardTitle>
          {!manage ? (
            <CardDescription>Only owners and admins can change members.</CardDescription>
          ) : null}
        </CardHeader>
        <CardContent>
          {query.data.items.length === 0 ? (
            <EmptyState title="No members yet" />
          ) : (
            <ul className="divide-y rounded-lg border" aria-label="Members">
              {query.data.items.map((m) => (
                <MemberRow
                  key={m.id}
                  organizationId={organizationId}
                  member={m}
                  actor={me && manage ? { userId: me.userId, role: me.role } : null}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function MemberRow({
  organizationId,
  member,
  actor,
}: {
  organizationId: Id;
  member: OrganizationMember;
  actor: { userId: string; role: Role } | null;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isSelf = actor?.userId === member.userId;
  const name = member.user.name?.trim() || member.user.email || 'Unnamed member';
  const roles = actor ? assignableRoles(actor, member) : [];
  const removable = actor ? canRemove(actor, member) : false;

  const refresh = async (sessionChanged: boolean) => {
    await queryClient.invalidateQueries({ queryKey: memberKeys.members(organizationId) });
    // A self role change rotates the session and re-derives its role.
    if (sessionChanged) await queryClient.invalidateQueries({ queryKey: queryKeys.session });
  };

  const changeRole = async (role: Role) => {
    if (role === member.role) return;
    setPending(true);
    setError(null);
    try {
      await api.members.changeRole(organizationId, member.userId, role);
      await refresh(isSelf);
    } catch (err) {
      setError(memberActionMessage('role', err));
      if (err instanceof ApiError && err.status === 404) await refresh(false);
    } finally {
      setPending(false);
    }
  };

  const remove = async () => {
    setPending(true);
    setError(null);
    try {
      await api.members.remove(organizationId, member.userId);
      await refresh(false);
    } catch (err) {
      setError(memberActionMessage('remove', err));
      if (err instanceof ApiError && err.status === 404) await refresh(false);
      setPending(false);
      setConfirmRemove(false);
    }
  };

  const selectId = `role-${member.userId}`;
  return (
    <li data-testid="member-row" className="grid gap-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-0.5">
          <span className="font-medium">
            {name}
            {isSelf ? <span className="text-muted-foreground"> (you)</span> : null}
          </span>
          {member.user.email ? (
            <span className="text-xs text-muted-foreground">{member.user.email}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {roles.length > 0 ? (
            <Select
              value={member.role}
              disabled={pending}
              onValueChange={(role) => void changeRole(role as Role)}
            >
              <SelectTrigger id={selectId} className="h-9 w-36" aria-label={`Role for ${name}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roles.map((r) => (
                  <SelectItem key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Badge variant={member.role === 'owner' ? 'default' : 'secondary'}>
              {ROLE_LABEL[member.role]}
            </Badge>
          )}
          {removable ? (
            confirmRemove ? (
              <>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={pending}
                  onClick={() => void remove()}
                >
                  {pending ? 'Removing…' : 'Confirm remove'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => setConfirmRemove(false)}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                aria-label={`Remove ${name}`}
                onClick={() => setConfirmRemove(true)}
              >
                Remove
              </Button>
            )
          ) : null}
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </li>
  );
}

function SentInvitations({
  organizationId,
  invitations,
  onChange,
}: {
  organizationId: Id;
  invitations: Invitation[];
  onChange: (invitation: Invitation) => void;
}) {
  const api = useApi();
  const [pending, setPending] = useState<string | null>(null);

  const run = async (inv: Invitation, action: 'resend' | 'revoke') => {
    setPending(inv.id);
    try {
      const next =
        action === 'resend'
          ? // Re-inviting replaces the pending invite (new link, old one stops working).
            await api.invitations.create(organizationId, { email: inv.email, role: inv.role })
          : await api.invitations.revoke(organizationId, inv.id);
      onChange(next);
      notify.success(
        action === 'resend'
          ? `Invitation resent to ${inv.email}.`
          : `Invitation to ${inv.email} revoked.`,
      );
    } catch (err) {
      notify.error(
        action === 'resend' ? "Couldn't resend invitation" : "Couldn't revoke invitation",
        memberActionMessage(action === 'resend' ? 'invite' : 'revoke', err),
      );
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="grid gap-2">
      <h3 className="text-sm font-medium">Sent from this page</h3>
      <ul className="divide-y rounded-lg border" aria-label="Invitations">
        {invitations.map((inv) => (
          <li
            key={inv.id}
            data-testid="invitation-row"
            className="flex flex-wrap items-center justify-between gap-3 p-3"
          >
            <span className="flex items-center gap-2 text-sm">
              {inv.email}
              <Badge variant="outline">{ROLE_LABEL[inv.role]}</Badge>
              <Badge variant={inv.status === 'pending' ? 'secondary' : 'outline'}>
                {inv.status === 'pending'
                  ? 'Pending'
                  : inv.status === 'revoked'
                    ? 'Revoked'
                    : 'Accepted'}
              </Badge>
            </span>
            {inv.status !== 'accepted' ? (
              <span className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending !== null}
                  aria-label={`Resend invitation to ${inv.email}`}
                  onClick={() => void run(inv, 'resend')}
                >
                  Resend
                </Button>
                {inv.status === 'pending' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending !== null}
                    aria-label={`Revoke invitation to ${inv.email}`}
                    onClick={() => void run(inv, 'revoke')}
                  >
                    Revoke
                  </Button>
                ) : null}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
