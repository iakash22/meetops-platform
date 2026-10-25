import type { ProjectDto } from '@meetops/contracts';
import type { ProjectRecord } from '../../directory/ports.js';
import { iso } from '../../directory/http/route-kit.js';

export const toProjectDto = (p: ProjectRecord): ProjectDto => ({
  id: p.id,
  organizationId: p.organizationId,
  name: p.name,
  key: p.key,
  description: p.description,
  status: p.status,
  teamId: p.teamId,
  createdAt: iso(p.createdAt),
  updatedAt: iso(p.updatedAt),
});
