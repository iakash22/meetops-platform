import { ROLES } from '@meetops/contracts/types';
import type { Role } from '@meetops/contracts';

/**
 * Who may open Analytics: a client-side mirror of the API gate, used only to decide what to show
 * (the API enforces it and its 404 is still handled by the page).
 *
 * `GET /orgs/:organizationId/analytics/meetings` authorizes CASL `read Meeting`
 * (`MeetingService.analytics` → `apps/api/src/modules/organizations/domain/abilities.ts`;
 * docs/12-security/rbac-matrix.md, "Meetings"). Every membership role holds that ability in its own
 * org and no membership holds nothing, so the check is "has a role in the active org", with no role
 * list of its own. `apps/api/test/abilities-analytics.test.ts` pins that every contracts `ROLES`
 * entry can `read Meeting`, so this mirror and the API cannot drift silently.
 */
export function canViewAnalytics(role: Role | null | undefined): boolean {
  return role != null && (ROLES as readonly string[]).includes(role);
}
