import type {
  AuthSession,
  CreateUploadResponse,
  GetAuthSessionResponse,
  Meeting,
  Organization,
  Paginated,
  Project,
  Task,
} from '@meetops/contracts';

const T = '2026-10-01T00:00:00.000Z';

export const orgs: Organization[] = [
  { id: 'org_1', name: 'Acme Inc', slug: 'acme', createdAt: T, updatedAt: T },
  { id: 'org_2', name: 'Globex', slug: 'globex', createdAt: T, updatedAt: T },
];

export const newOrg: Organization = {
  id: 'org_3',
  name: 'Initech',
  slug: 'initech',
  createdAt: T,
  updatedAt: T,
};

export const user = {
  id: 'usr_1',
  email: 'ada@example.com',
  name: 'Ada',
  createdAt: T,
  updatedAt: T,
};

export const session: AuthSession = {
  user,
  csrfToken: 'csrf-token-from-login-0001',
  activeOrganizationId: 'org_1',
  role: 'owner',
  organizations: orgs,
};

export const sessionResponse: GetAuthSessionResponse = {
  user,
  activeOrganizationId: 'org_1',
  role: 'owner',
  organizations: orgs,
};

export const meeting1: Meeting = {
  id: 'mtg_1',
  organizationId: 'org_1',
  title: 'Weekly sync',
  source: 'upload',
  status: 'completed',
  startedAt: '2026-10-20T10:00:00.000Z',
  endedAt: '2026-10-20T10:30:00.000Z',
  createdById: 'usr_1',
  createdAt: T,
  updatedAt: T,
};

export const meetings: Paginated<Meeting> = {
  items: [
    meeting1,
    {
      id: 'mtg_2',
      organizationId: 'org_1',
      title: 'Planning',
      source: 'extension',
      status: 'recording',
      startedAt: '2026-10-22T10:00:00.000Z',
      createdById: 'usr_1',
      createdAt: T,
      updatedAt: T,
    },
  ],
  nextCursor: null,
};

export const task1: Task = {
  id: 'tsk_1',
  organizationId: 'org_1',
  title: 'Send recap',
  status: 'todo',
  priority: 'medium',
  createdAt: T,
  updatedAt: T,
};

export const tasks: Paginated<Task> = {
  items: [
    task1,
    { ...task1, id: 'tsk_2', title: 'Old idea', status: 'cancelled', priority: 'low' },
  ],
  nextCursor: null,
};

export const projects: Paginated<Project> = {
  items: [{ id: 'prj_1', organizationId: 'org_1', name: 'Launch', createdAt: T, updatedAt: T }],
  nextCursor: null,
};

export const uploadResponse: CreateUploadResponse = {
  fileObjectId: 'fo_1',
  upload: {
    url: 'https://storage.example.com/upload?sig=abc',
    method: 'PUT',
    headers: { 'Content-Type': 'audio/webm' },
    expiresAt: '2026-10-21T18:00:00.000Z',
  },
};
