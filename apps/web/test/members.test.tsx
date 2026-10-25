import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ListMembersResponse, Role } from '@meetops/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assignableRoles,
  canManageMembers,
  canRemove,
  invitableRoles,
} from '@/features/members/permissions';
import { ApiError } from '@/lib/api/client';
import { memberList } from './fixtures/data';
import { createMockApi, renderApp, resetStores } from './fixtures/render';

const ORG = '00000000-0000-4000-8000-000000000001';
const conflict = (reason: 'ALREADY_MEMBER' | 'LAST_OWNER') =>
  ApiError.fromResponse(409, { error: { code: 'CONFLICT', message: 'x', reason } });
const userId = (n: number) => `10000000-0000-4000-8000-00000000000${n}`;

/** memberList with Ada (the signed-in user, user 1) given `role`. */
function membersAs(role: Role, others: Partial<Record<number, Role>> = {}): ListMembersResponse {
  return {
    ...memberList,
    items: memberList.items.map((m, i) => ({
      ...m,
      role: i === 0 ? role : (others[i + 1] ?? m.role),
    })),
  };
}

async function openMembers(api = createMockApi(), path = '/organization/members') {
  const result = renderApp(path, api);
  expect(await screen.findByRole('heading', { name: 'Members', level: 1 })).toBeInTheDocument();
  await screen.findAllByTestId('member-row');
  return result;
}

const row = (name: string) =>
  screen
    .getAllByTestId('member-row')
    .find((r) => within(r).queryAllByText(name, { exact: false }).length > 0)!;

describe('/organization/members as owner', () => {
  beforeEach(() => resetStores());

  it('lists members with roles and loads the active org', async () => {
    const { api } = await openMembers();
    expect(api.members.list).toHaveBeenCalledWith(ORG, expect.objectContaining({ limit: 100 }));
    expect(screen.getAllByTestId('member-row')).toHaveLength(4);
    expect(within(row('Ada')).getByText('(you)', { exact: false })).toBeInTheDocument();
    expect(screen.getByLabelText('Role for Grace')).toHaveValue('admin');
    expect(screen.getByLabelText('Role for Barbara')).toHaveValue('viewer');
    expect(within(row('Linus')).getByText('linus@example.com')).toBeInTheDocument();
    // No self-remove from this screen.
    expect(screen.queryByRole('button', { name: 'Remove Ada' })).toBeNull();
  });

  it('invites by email, then resends and revokes from the sent list', async () => {
    const { api } = await openMembers();
    const form = screen.getByRole('form', { name: 'Invite a member' });
    await userEvent.type(within(form).getByLabelText('Email'), 'new.person@example.com');
    await userEvent.selectOptions(within(form).getByLabelText('Role'), 'admin');
    await userEvent.click(within(form).getByRole('button', { name: 'Send invite' }));

    expect(
      await screen.findByText('Invitation sent to new.person@example.com.'),
    ).toBeInTheDocument();
    expect(api.invitations.create).toHaveBeenCalledWith(ORG, {
      email: 'new.person@example.com',
      role: 'admin',
    });
    const sent = screen.getByRole('list', { name: 'Invitations' });
    expect(within(sent).getByText('Pending')).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', { name: 'Resend invitation to new.person@example.com' }),
    );
    expect(
      await screen.findByText('Invitation resent to new.person@example.com.'),
    ).toBeInTheDocument();
    expect(api.invitations.create).toHaveBeenCalledTimes(2);

    await userEvent.click(
      screen.getByRole('button', { name: 'Revoke invitation to new.person@example.com' }),
    );
    expect(
      await screen.findByText('Invitation to new.person@example.com revoked.'),
    ).toBeInTheDocument();
    expect(api.invitations.revoke).toHaveBeenCalledWith(ORG, expect.any(String));
    expect(within(sent).getByText('Revoked')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Revoke invitation/ })).toBeNull();
  });

  it('validates the email before calling the API', async () => {
    const { api } = await openMembers();
    const form = screen.getByRole('form', { name: 'Invite a member' });
    await userEvent.type(within(form).getByLabelText('Email'), 'not-an-email');
    await userEvent.click(within(form).getByRole('button', { name: 'Send invite' }));
    expect(await within(form).findByText(/valid email/i)).toBeInTheDocument();
    expect(api.invitations.create).not.toHaveBeenCalled();
  });

  it('explains ALREADY_MEMBER', async () => {
    const api = createMockApi({
      invitations: {
        create: vi.fn().mockRejectedValue(conflict('ALREADY_MEMBER')),
      },
    });
    await openMembers(api);
    const form = screen.getByRole('form', { name: 'Invite a member' });
    await userEvent.type(within(form).getByLabelText('Email'), 'linus@example.com');
    await userEvent.click(within(form).getByRole('button', { name: 'Send invite' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That person is already a member of this organization.',
    );
  });

  it('changes a role and refreshes the list', async () => {
    const { api } = await openMembers();
    await userEvent.selectOptions(screen.getByLabelText('Role for Linus'), 'viewer');
    await waitFor(() =>
      expect(api.members.changeRole).toHaveBeenCalledWith(ORG, userId(3), 'viewer'),
    );
    await waitFor(() => expect(api.members.list).toHaveBeenCalledTimes(2));
  });

  it('explains LAST_OWNER', async () => {
    const api = createMockApi({
      members: {
        changeRole: vi.fn().mockRejectedValue(conflict('LAST_OWNER')),
      },
    });
    await openMembers(api);
    await userEvent.selectOptions(screen.getByLabelText('Role for Ada'), 'admin');
    expect(await within(row('Ada')).findByRole('alert')).toHaveTextContent(
      'An organization must keep at least one owner.',
    );
  });

  it('removes a member after confirming', async () => {
    const { api } = await openMembers();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Barbara' }));
    expect(api.members.remove).not.toHaveBeenCalled();
    await userEvent.click(within(row('Barbara')).getByRole('button', { name: 'Confirm remove' }));
    await waitFor(() => expect(api.members.remove).toHaveBeenCalledWith(ORG, userId(4)));
    await waitFor(() => expect(api.members.list).toHaveBeenCalledTimes(2));
  });

  it('a forbidden remove shows a fixed message', async () => {
    const api = createMockApi({
      members: { remove: vi.fn().mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'raw')) },
    });
    await openMembers(api);
    await userEvent.click(screen.getByRole('button', { name: 'Remove Linus' }));
    await userEvent.click(within(row('Linus')).getByRole('button', { name: 'Confirm remove' }));
    expect(await within(row('Linus')).findByRole('alert')).toHaveTextContent(
      "You can't remove this member.",
    );
    expect(screen.queryByText('raw')).toBeNull();
  });
});

describe('/organization/members gating', () => {
  beforeEach(() => resetStores());

  it.each(['member', 'viewer'] as const)('a %s sees the list but no controls', async (role) => {
    const api = createMockApi({ members: { list: vi.fn().mockResolvedValue(membersAs(role)) } });
    await openMembers(api);
    expect(screen.getByText('Only owners and admins can change members.')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Invite a member' })).toBeNull();
    expect(
      within(screen.getByRole('list', { name: 'Members' })).queryByRole('combobox'),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
    expect(within(row('Grace')).getByText('Admin')).toBeInTheDocument();
  });

  it('an admin can manage members/viewers only, and invite member/viewer', async () => {
    // Ada is admin; Grace (2) becomes the owner.
    const api = createMockApi({
      members: { list: vi.fn().mockResolvedValue(membersAs('admin', { 2: 'owner' })) },
    });
    await openMembers(api);
    expect(screen.queryByLabelText('Role for Ada')).toBeNull();
    expect(screen.queryByLabelText('Role for Grace')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove Grace' })).toBeNull();
    const linus = screen.getByLabelText('Role for Linus');
    expect(
      within(linus)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Member', 'Viewer']);
    expect(screen.getByRole('button', { name: 'Remove Barbara' })).toBeInTheDocument();
    const roleSelect = within(screen.getByRole('form', { name: 'Invite a member' })).getByLabelText(
      'Role',
    );
    expect(
      within(roleSelect)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Member', 'Viewer']);
  });
});

describe('/organization/members org resolution', () => {
  beforeEach(() => resetStores());

  it('an org the caller is not in (API 404) renders not found', async () => {
    const other = '00000000-0000-4000-8000-0000000000ff';
    const api = createMockApi({
      members: { list: vi.fn().mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'x')) },
    });
    renderApp(`/organization/members?org=${other}`, api);
    expect(await screen.findByText('Organization not found')).toBeInTheDocument();
    expect(api.members.list).toHaveBeenCalledWith(other, expect.anything());
    expect(screen.queryByRole('form', { name: 'Invite a member' })).toBeNull();
  });

  it('a malformed ?org= is not found without calling the API', async () => {
    const api = createMockApi();
    renderApp('/organization/members?org=not-a-uuid', api);
    expect(await screen.findByText('Organization not found')).toBeInTheDocument();
    expect(api.members.list).not.toHaveBeenCalled();
  });

  it('other load failures show the error state', async () => {
    const api = createMockApi({
      members: { list: vi.fn().mockRejectedValue(new ApiError(500, 'INTERNAL', 'x')) },
    });
    renderApp('/organization/members', api);
    expect(await screen.findByTestId('error-state')).toBeInTheDocument();
  });

  it('is reachable from the sidebar', async () => {
    const api = createMockApi();
    renderApp('/account', api);
    expect(await screen.findByRole('heading', { name: 'Account' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'Members' }));
    expect(await screen.findByRole('heading', { name: 'Members', level: 1 })).toBeInTheDocument();
  });
});

describe('member permissions (mirror of API rules)', () => {
  const me = (role: Role) => ({ userId: 'me', role });
  const them = (role: Role) => ({ userId: 'them', role });

  it('only owners/admins manage', () => {
    expect(
      ['owner', 'admin', 'member', 'viewer', null].map((r) => canManageMembers(r as Role)),
    ).toEqual([true, true, false, false, false]);
  });

  it('invitable roles', () => {
    expect(invitableRoles('owner')).toEqual(['admin', 'member', 'viewer']);
    expect(invitableRoles('admin')).toEqual(['member', 'viewer']);
    expect(invitableRoles('member')).toEqual([]);
  });

  it('assignable roles', () => {
    expect(assignableRoles(me('owner'), them('admin'))).toEqual([
      'owner',
      'admin',
      'member',
      'viewer',
    ]);
    expect(assignableRoles(me('admin'), them('member'))).toEqual(['member', 'viewer']);
    expect(assignableRoles(me('admin'), them('admin'))).toEqual([]);
    expect(assignableRoles(me('admin'), them('owner'))).toEqual([]);
    expect(assignableRoles(me('admin'), { userId: 'me', role: 'admin' })).toEqual([]);
    expect(assignableRoles(me('viewer'), them('viewer'))).toEqual([]);
  });

  it('removal', () => {
    expect(canRemove(me('owner'), them('owner'))).toBe(true);
    expect(canRemove(me('admin'), them('viewer'))).toBe(true);
    expect(canRemove(me('admin'), them('admin'))).toBe(false);
    expect(canRemove(me('member'), them('viewer'))).toBe(false);
    expect(canRemove(me('owner'), { userId: 'me', role: 'owner' })).toBe(false);
  });
});
