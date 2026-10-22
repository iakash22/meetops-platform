import type { CreateUploadResponse } from '@meetops/contracts';
import type { AuthSession, Meeting, Organization, Paginated, Project, Task } from '@/lib/api/types';

export const orgs: Organization[] = [
  { id: 'org_1', name: 'Acme Inc', slug: 'acme' },
  { id: 'org_2', name: 'Globex', slug: 'globex' },
];

export const session: AuthSession = {
  user: { id: 'usr_1', email: 'ada@example.com', name: 'Ada' },
  organizations: orgs,
};

export const meetings: Paginated<Meeting> = {
  items: [
    {
      id: 'mtg_1',
      orgId: 'org_1',
      title: 'Weekly sync',
      startsAt: '2026-10-20T10:00:00Z',
      status: 'completed',
    },
    {
      id: 'mtg_2',
      orgId: 'org_1',
      title: 'Planning',
      startsAt: '2026-10-22T10:00:00Z',
      status: 'scheduled',
    },
  ],
};

export const tasks: Paginated<Task> = {
  items: [{ id: 'tsk_1', orgId: 'org_1', title: 'Send recap', status: 'todo' }],
};

export const projects: Paginated<Project> = {
  items: [{ id: 'prj_1', orgId: 'org_1', name: 'Launch' }],
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
