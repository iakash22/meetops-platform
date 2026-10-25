import type {
  EmployeeDto,
  ProjectDto,
  TeamDto,
  TeamMemberDto,
} from '@/features/directory/contracts-shim';
import type { MockDirectorySeed } from '@/features/directory/mock-api';

const T = '2026-10-01T00:00:00.000Z';
export const ORG_A = '00000000-0000-4000-8000-000000000001';
export const ORG_B = '00000000-0000-4000-8000-000000000002';

export const grace: EmployeeDto = {
  id: '51000000-0000-4000-8000-000000000001',
  organizationId: ORG_A,
  userId: null,
  fullName: 'Grace Hopper',
  email: 'grace@example.com',
  title: 'Staff Engineer',
  department: 'Eng',
  externalId: null,
  createdAt: T,
  updatedAt: T,
};
export const alan: EmployeeDto = {
  ...grace,
  id: '51000000-0000-4000-8000-000000000002',
  fullName: 'Alan Turing',
  email: 'alan@example.com',
  title: 'Researcher',
  department: 'R&D',
};
export const platform: TeamDto = {
  id: '52000000-0000-4000-8000-000000000001',
  organizationId: ORG_A,
  name: 'Platform',
  key: 'PLAT',
  description: 'Core services',
  createdAt: T,
  updatedAt: T,
};
export const graceLead: TeamMemberDto = {
  organizationId: ORG_A,
  teamId: platform.id,
  employeeId: grace.id,
  role: 'lead',
  createdAt: T,
  employee: grace,
};
export const launch: ProjectDto = {
  id: '53000000-0000-4000-8000-000000000001',
  organizationId: ORG_A,
  name: 'Launch',
  key: 'LAUNCH',
  description: null,
  status: 'active',
  teamId: platform.id,
  createdAt: T,
  updatedAt: T,
};
export const oldProject: ProjectDto = {
  ...launch,
  id: '53000000-0000-4000-8000-000000000002',
  name: 'Legacy',
  key: 'OLD',
  status: 'archived',
  teamId: null,
};
/** A row in another org: must never show up for ORG_A. */
export const otherOrgProject: ProjectDto = {
  ...launch,
  id: '53000000-0000-4000-8000-000000000003',
  organizationId: ORG_B,
  name: 'Globex secret',
  key: 'SECRET',
  teamId: null,
};

export const directorySeed = (): MockDirectorySeed => ({
  employees: [grace, alan],
  teams: [platform],
  members: [graceLead],
  projects: [launch, oldProject, otherOrgProject],
});
