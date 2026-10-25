import type { TeamDto, TeamMemberDto } from '@meetops/contracts';
import type { TeamMemberRecord, TeamRecord } from '../../directory/ports.js';
import { iso } from '../../directory/http/route-kit.js';
import { toEmployeeDto } from '../../employees/http/mappers.js';

export const toTeamDto = (t: TeamRecord): TeamDto => ({
  id: t.id,
  organizationId: t.organizationId,
  name: t.name,
  key: t.key,
  description: t.description,
  createdAt: iso(t.createdAt),
  updatedAt: iso(t.updatedAt),
});

export const toTeamMemberDto = (
  m: TeamMemberRecord,
  opts: { withEmail: boolean },
): TeamMemberDto => ({
  organizationId: m.organizationId,
  teamId: m.teamId,
  employeeId: m.employeeId,
  role: m.role,
  createdAt: iso(m.createdAt),
  employee: toEmployeeDto(m.employee, opts),
});
