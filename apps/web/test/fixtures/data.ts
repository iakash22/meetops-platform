import type {
  AuthSession,
  CreateUploadResponse,
  ExtensionPairResponse,
  GetAuthSessionResponse,
  Meeting,
  Organization,
  Paginated,
  Project,
  Task,
} from '@meetops/contracts';

const T = '2026-10-01T00:00:00.000Z';

export const orgs: Organization[] = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Acme Inc',
    slug: 'acme',
    createdAt: T,
    updatedAt: T,
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    name: 'Globex',
    slug: 'globex',
    createdAt: T,
    updatedAt: T,
  },
];

export const newOrg: Organization = {
  id: '00000000-0000-4000-8000-000000000003',
  name: 'Initech',
  slug: 'initech',
  createdAt: T,
  updatedAt: T,
};

export const user = {
  id: '10000000-0000-4000-8000-000000000001',
  email: 'ada@example.com',
  name: 'Ada',
  createdAt: T,
  updatedAt: T,
};

export const session: AuthSession = {
  user,
  csrfToken: 'csrf-token-from-login-0001',
  activeOrganizationId: '00000000-0000-4000-8000-000000000001',
  role: 'owner',
  organizations: orgs,
};

export const sessionResponse: GetAuthSessionResponse = {
  user,
  activeOrganizationId: '00000000-0000-4000-8000-000000000001',
  role: 'owner',
  organizations: orgs,
};

export const meeting1: Meeting = {
  id: '20000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000001',
  title: 'Weekly sync',
  source: 'upload',
  status: 'completed',
  startedAt: '2026-10-20T10:00:00.000Z',
  endedAt: '2026-10-20T10:30:00.000Z',
  createdById: '10000000-0000-4000-8000-000000000001',
  createdAt: T,
  updatedAt: T,
};

export const meetings: Paginated<Meeting> = {
  items: [
    meeting1,
    {
      id: '20000000-0000-4000-8000-000000000002',
      organizationId: '00000000-0000-4000-8000-000000000001',
      title: 'Planning',
      source: 'extension',
      status: 'recording',
      startedAt: '2026-10-22T10:00:00.000Z',
      createdById: '10000000-0000-4000-8000-000000000001',
      createdAt: T,
      updatedAt: T,
    },
  ],
  nextCursor: null,
};

export const task1: Task = {
  id: '30000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000001',
  title: 'Send recap',
  status: 'todo',
  priority: 'medium',
  createdAt: T,
  updatedAt: T,
};

export const tasks: Paginated<Task> = {
  items: [
    task1,
    {
      ...task1,
      id: '30000000-0000-4000-8000-000000000002',
      title: 'Old idea',
      status: 'cancelled',
      priority: 'low',
    },
  ],
  nextCursor: null,
};

export const projects: Paginated<Project> = {
  items: [
    {
      id: '40000000-0000-4000-8000-000000000001',
      organizationId: '00000000-0000-4000-8000-000000000001',
      name: 'Launch',
      createdAt: T,
      updatedAt: T,
    },
  ],
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

export const pairResponse: ExtensionPairResponse = {
  pairingCode: 'P'.repeat(40),
  expiresAt: '2026-10-01T00:01:00.000Z',
  organizationId: '00000000-0000-4000-8000-000000000001',
  organizationName: 'Acme Inc',
};
