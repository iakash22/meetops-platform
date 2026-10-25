import type { EmployeeDto } from '@meetops/contracts';
import type { EmployeeRecord } from '../../directory/ports.js';
import { iso } from '../../directory/http/route-kit.js';

/** `email` is only present for callers who may see contact details (owner/admin); others never get the key. */
export function toEmployeeDto(e: EmployeeRecord, opts: { withEmail: boolean }): EmployeeDto {
  return {
    id: e.id,
    organizationId: e.organizationId,
    userId: e.userId,
    fullName: e.fullName,
    ...(opts.withEmail ? { email: e.email } : {}),
    title: e.title,
    department: e.department,
    externalId: e.externalId,
    createdAt: iso(e.createdAt),
    updatedAt: iso(e.updatedAt),
  };
}
