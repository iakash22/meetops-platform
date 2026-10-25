import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GetAuthSessionResponse } from '@meetops/contracts';
import { createMockDirectoryApi } from '@/features/directory/mock-api';
import { createMockApi, renderApp, resetStores } from './fixtures/render';
import { sessionResponse } from './fixtures/data';
import { directorySeed, ORG_B, platform } from './fixtures/directory';

type Role = GetAuthSessionResponse['role'];

function setup(path: string, role: Role = 'owner', activeOrganizationId?: string) {
  const directory = createMockDirectoryApi(directorySeed());
  const api = createMockApi({
    auth: {
      session: vi.fn().mockResolvedValue({
        ...sessionResponse,
        role,
        ...(activeOrganizationId ? { activeOrganizationId } : {}),
      }),
    },
    directory,
  });
  const utils = renderApp(path, api);
  return { ...utils, directory, user: userEvent.setup() };
}

const list = (name: string) => screen.findByRole('list', { name });

/** Pick an option in a shared (Radix) Select; its listbox renders in a portal. */
async function choose(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(screen.getByRole('combobox', { name: label }));
  await user.click(await screen.findByRole('option', { name: option }));
}

describe('/projects', () => {
  beforeEach(() => resetStores());

  it('lists active projects of the current org with key, status and team', async () => {
    setup('/projects');
    const projects = await list('Projects');
    const row = within(projects).getByText('Launch').closest('li');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('LAUNCH')).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('active')).toBeInTheDocument();
    expect(await within(row as HTMLElement).findByText('Team: Platform')).toBeInTheDocument();
    // Archived projects are filtered out by default; other orgs never appear.
    expect(within(projects).queryByText('Legacy')).not.toBeInTheDocument();
    expect(screen.queryByText('Globex secret')).not.toBeInTheDocument();
  });

  it('filters by status', async () => {
    const { user } = setup('/projects');
    await list('Projects');
    await choose(user, 'Status', 'archived');
    expect(await screen.findByText('Legacy')).toBeInTheDocument();
    expect(screen.queryByText('Launch')).not.toBeInTheDocument();
  });

  it('creates a project for owner/admin and shows a taken key', async () => {
    const { user, directory } = setup('/projects', 'admin');
    await list('Projects');
    const create = vi.spyOn(directory.projects, 'create');
    const form = screen.getByRole('form', { name: 'New project' });
    await user.type(within(form).getByLabelText('Project name'), 'Billing v2');
    await user.type(within(form).getByLabelText('Project key'), 'bad key');
    await user.click(within(form).getByRole('button', { name: 'Create project' }));
    expect(await within(form).findByText(/2-10 uppercase letters/)).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();

    await user.clear(within(form).getByLabelText('Project key'));
    await user.type(within(form).getByLabelText('Project key'), 'LAUNCH');
    await user.click(within(form).getByRole('button', { name: 'Create project' }));
    expect(
      await within(form).findByText('That project key is already in use.'),
    ).toBeInTheDocument();

    await user.clear(within(form).getByLabelText('Project key'));
    await user.type(within(form).getByLabelText('Project key'), 'BILL2');
    await choose(user, 'Team (optional)', 'Platform');
    await user.click(within(form).getByRole('button', { name: 'Create project' }));
    expect(await within(await list('Projects')).findByText('Billing v2')).toBeInTheDocument();
    expect(create).toHaveBeenLastCalledWith(sessionResponse.activeOrganizationId, {
      name: 'Billing v2',
      key: 'BILL2',
      teamId: platform.id,
    });
  });

  it('archives and deletes a project', async () => {
    const { user } = setup('/projects');
    await list('Projects');
    await user.click(screen.getByRole('button', { name: 'Archive Launch' }));
    await waitFor(() => expect(screen.queryByText('Launch')).not.toBeInTheDocument());

    await choose(user, 'Status', 'archived');
    await user.click(await screen.findByRole('button', { name: 'Delete Legacy' }));
    await user.click(screen.getByRole('button', { name: 'Confirm delete Legacy' }));
    await waitFor(() => expect(screen.queryByText('Legacy')).not.toBeInTheDocument());
    expect(screen.getByText('Launch')).toBeInTheDocument();
  });

  it.each<Role>(['member', 'viewer'])('is read-only for %s', async (role) => {
    setup('/projects', role);
    expect(await screen.findByText('Launch')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'New project' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Archive|Delete/ })).not.toBeInTheDocument();
  });

  it('is read-only when the session role belongs to another org', async () => {
    setup('/projects', 'owner', ORG_B);
    expect(await screen.findByText('Launch')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'New project' })).not.toBeInTheDocument();
  });
});

describe('/settings', () => {
  beforeEach(() => resetStores());

  it('defaults to the employees tab and lists employees', async () => {
    setup('/settings');
    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Employees' })).toHaveAttribute('aria-current', 'page');
    const employees = await list('Employees');
    expect(within(employees).getByText('Grace Hopper')).toBeInTheDocument();
    expect(within(employees).getByText('Staff Engineer · Eng')).toBeInTheDocument();
    expect(within(employees).getByText('grace@example.com')).toBeInTheDocument();
  });

  it('falls back to employees for an unknown tab', async () => {
    setup('/settings?tab=%3Cscript%3E');
    expect(await list('Employees')).toBeInTheDocument();
  });

  it('adds and deletes an employee', async () => {
    const { user } = setup('/settings');
    await list('Employees');
    const form = screen.getByRole('form', { name: 'Add employee' });
    await user.type(within(form).getByLabelText('Full name'), 'Katherine Johnson');
    await user.type(within(form).getByLabelText('Email'), 'kj@example.com');
    await user.click(within(form).getByRole('button', { name: 'Add employee' }));
    expect(await screen.findByText('Katherine Johnson')).toBeInTheDocument();
    expect(within(form).getByLabelText('Full name')).toHaveValue('');

    await user.click(screen.getByRole('button', { name: 'Delete Alan Turing' }));
    await user.click(screen.getByRole('button', { name: 'Confirm delete Alan Turing' }));
    await waitFor(() => expect(screen.queryByText('Alan Turing')).not.toBeInTheDocument());
  });

  it('searches employees', async () => {
    const { user, directory } = setup('/settings');
    await list('Employees');
    const spy = vi.spyOn(directory.employees, 'list');
    await user.type(screen.getByLabelText('Search employees'), 'alan');
    await waitFor(() => expect(screen.queryByText('Grace Hopper')).not.toBeInTheDocument());
    // Previous results stay on screen while the search refetches (no loading flash).
    expect(screen.getByText('Alan Turing')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: /loading/i })).not.toBeInTheDocument();
    expect(spy).toHaveBeenLastCalledWith(sessionResponse.activeOrganizationId, { q: 'alan' });
  });

  it('lists and creates teams on the teams tab', async () => {
    const { user } = setup('/settings?tab=teams');
    const teams = await list('Teams');
    expect(within(teams).getByRole('link', { name: 'Platform' })).toHaveAttribute(
      'href',
      `/settings/teams/${platform.id}`,
    );
    const form = screen.getByRole('form', { name: 'Create team' });
    await user.type(within(form).getByLabelText('Team name'), 'platform');
    await user.click(within(form).getByRole('button', { name: 'Create team' }));
    expect(
      await within(form).findByText('A team with that name or key already exists.'),
    ).toBeInTheDocument();
    await user.clear(within(form).getByLabelText('Team name'));
    await user.type(within(form).getByLabelText('Team name'), 'Data');
    await user.type(within(form).getByLabelText('Team key (optional)'), 'DATA');
    await user.click(within(form).getByRole('button', { name: 'Create team' }));
    expect(await within(await list('Teams')).findByText('Data')).toBeInTheDocument();
  });

  it('hides employee and team write controls for viewers', async () => {
    setup('/settings?tab=teams', 'viewer');
    expect(await list('Teams')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Create team' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument();
  });
});

describe('/settings/teams/:teamId', () => {
  beforeEach(() => resetStores());

  it('shows members and lets an owner add, promote and remove them', async () => {
    const { user } = setup(`/settings/teams/${platform.id}`);
    expect(await screen.findByRole('heading', { name: 'Platform' })).toBeInTheDocument();
    const members = await list('Team members');
    expect(within(members).getByText('Grace Hopper')).toBeInTheDocument();
    expect(within(members).getByText('lead')).toBeInTheDocument();

    const form = screen.getByRole('form', { name: 'Add member' });
    // Existing members are not offered again.
    await user.click(within(form).getByRole('combobox', { name: 'Employee' }));
    expect(await screen.findByRole('option', { name: 'Alan Turing' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Grace Hopper' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'Alan Turing' }));
    expect(within(form).getByRole('combobox', { name: 'Employee' })).toHaveTextContent(
      'Alan Turing',
    );
    await user.click(within(form).getByRole('button', { name: 'Add member' }));
    const alanRow = (await within(members).findByText('Alan Turing')).closest('li') as HTMLElement;
    expect(within(alanRow).getByText('member')).toBeInTheDocument();

    await user.click(within(alanRow).getByRole('button', { name: 'Make lead' }));
    expect(await within(alanRow).findByText('lead')).toBeInTheDocument();

    await user.click(within(alanRow).getByRole('button', { name: 'Delete Alan Turing' }));
    await user.click(within(alanRow).getByRole('button', { name: 'Confirm delete Alan Turing' }));
    await waitFor(() => expect(within(members).queryByText('Alan Turing')).not.toBeInTheDocument());
  });

  it('requires an employee before adding', async () => {
    const { user } = setup(`/settings/teams/${platform.id}`);
    const form = await screen.findByRole('form', { name: 'Add member' });
    await user.click(within(form).getByRole('button', { name: 'Add member' }));
    expect(await within(form).findByText('Choose an employee')).toBeInTheDocument();
  });

  it('is read-only for members', async () => {
    setup(`/settings/teams/${platform.id}`, 'member');
    expect(await list('Team members')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Add member' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Make|Delete/ })).not.toBeInTheDocument();
  });

  it('shows an error for a team outside the org', async () => {
    setup('/settings/teams/52000000-0000-4000-8000-0000000000ff');
    expect(await screen.findByText('Could not load team')).toBeInTheDocument();
  });
});
