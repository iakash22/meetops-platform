import type {
  AuthSession,
  CreateUploadResponse,
  ExtensionPairResponse,
  GetAuthSessionResponse,
  ListMembersResponse,
  ListSessionsResponse,
  Meeting,
  Organization,
  OrganizationMember,
  Paginated,
  Project,
  Role,
  Task,
} from '@meetops/contracts';
import type { Invitation } from '@/lib/api/client';

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
  expiresAt: '2999-01-01T00:01:00.000Z',
  organizationId: '00000000-0000-4000-8000-000000000001',
  organizationName: 'Acme Inc',
};

const ORG_A = '00000000-0000-4000-8000-000000000001';

/** GET /auth/sessions: this browser (current) plus another device. */
export const sessionList: ListSessionsResponse = {
  items: [
    {
      id: '20000000-0000-4000-8000-000000000001',
      current: true,
      createdAt: T,
      lastSeenAt: '2026-10-24T10:00:00.000Z',
      expiresAt: '2026-11-24T10:00:00.000Z',
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (Macintosh) Firefox/131.0',
    },
    {
      id: '20000000-0000-4000-8000-000000000002',
      current: false,
      createdAt: T,
      lastSeenAt: '2026-10-20T08:00:00.000Z',
      expiresAt: '2026-11-20T08:00:00.000Z',
      ip: null,
      userAgent: 'Mozilla/5.0 (iPhone) Safari/604.1',
    },
  ],
  nextCursor: null,
};

const member = (n: number, role: Role, name: string, email?: string): OrganizationMember => ({
  id: `30000000-0000-4000-8000-00000000000${n}`,
  organizationId: ORG_A,
  userId: `10000000-0000-4000-8000-00000000000${n}`,
  role,
  createdAt: T,
  user: {
    id: `10000000-0000-4000-8000-00000000000${n}`,
    name,
    ...(email ? { email } : {}),
  },
});

/** GET /orgs/:id/members as seen by an owner/admin (emails included). Ada (user 1) is the owner. */
export const memberList: ListMembersResponse = {
  items: [
    member(1, 'owner', 'Ada', 'ada@example.com'),
    member(2, 'admin', 'Grace', 'grace@example.com'),
    member(3, 'member', 'Linus', 'linus@example.com'),
    member(4, 'viewer', 'Barbara', 'barbara@example.com'),
  ],
  nextCursor: null,
};

export const invitation: Invitation = {
  id: '40000000-0000-4000-8000-000000000001',
  organizationId: ORG_A,
  email: 'new.person@example.com',
  role: 'member',
  status: 'pending',
  expiresAt: '2026-11-01T00:00:00.000Z',
};
