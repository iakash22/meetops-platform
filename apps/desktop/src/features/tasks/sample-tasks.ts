import type { Task } from '@meetops/contracts';

const ORG = '00000000-0000-4000-8000-000000000001';

/** Typed placeholder rows until the desktop bearer can read `GET /orgs/:id/tasks`. */
export const SAMPLE_TASKS: readonly Task[] = [
  {
    id: '20000000-0000-4000-8000-000000000001',
    organizationId: ORG,
    meetingId: '10000000-0000-4000-8000-000000000001',
    title: 'Send the sync notes to the team',
    status: 'todo',
    priority: 'medium',
    dueAt: '2026-01-08T17:00:00.000Z',
    createdAt: '2026-01-05T11:00:00.000Z',
    updatedAt: '2026-01-05T11:00:00.000Z',
  },
  {
    id: '20000000-0000-4000-8000-000000000002',
    organizationId: ORG,
    title: 'Draft the onboarding checklist',
    status: 'in_progress',
    priority: 'high',
    createdAt: '2026-01-06T15:00:00.000Z',
    updatedAt: '2026-01-06T15:30:00.000Z',
  },
  {
    id: '20000000-0000-4000-8000-000000000003',
    organizationId: ORG,
    title: 'Book the sprint retro room',
    status: 'done',
    priority: 'low',
    createdAt: '2026-01-07T09:30:00.000Z',
    updatedAt: '2026-01-07T10:00:00.000Z',
  },
];
