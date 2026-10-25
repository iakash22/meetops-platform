import type { Meeting } from '@meetops/contracts';

const ORG = '00000000-0000-4000-8000-000000000001';

/** Placeholder rows until the meetings API and offline recording land (Phase 8). Typed by contracts. */
export const SAMPLE_MEETINGS: readonly Meeting[] = [
  {
    id: '10000000-0000-4000-8000-000000000001',
    organizationId: ORG,
    title: 'Weekly product sync',
    source: 'desktop',
    status: 'completed',
    startedAt: '2026-01-05T10:00:00.000Z',
    endedAt: '2026-01-05T10:45:00.000Z',
    createdById: null,
    createdAt: '2026-01-05T10:00:00.000Z',
    updatedAt: '2026-01-05T10:50:00.000Z',
  },
  {
    id: '10000000-0000-4000-8000-000000000002',
    organizationId: ORG,
    title: 'Customer onboarding call',
    source: 'upload',
    status: 'processing',
    startedAt: '2026-01-06T14:00:00.000Z',
    createdById: null,
    createdAt: '2026-01-06T14:00:00.000Z',
    updatedAt: '2026-01-06T14:30:00.000Z',
  },
  {
    id: '10000000-0000-4000-8000-000000000003',
    organizationId: ORG,
    title: 'Sprint planning',
    source: 'desktop',
    status: 'scheduled',
    createdById: null,
    createdAt: '2026-01-07T09:00:00.000Z',
    updatedAt: '2026-01-07T09:00:00.000Z',
  },
];
