import { describe, expect, it } from 'vitest';
import { ROLES } from '@meetops/contracts';
import { defineAbilityFor, orgSubject } from '../src/modules/organizations/domain/abilities.js';

// The analytics endpoint (GET /orgs/:id/analytics/meetings) authorizes CASL `read Meeting`.
// apps/web/src/features/analytics/permissions.ts mirrors that as "any membership role in the active
// org" to decide whether to show the Analytics nav entry and page. This pins the assumption: if a
// role ever loses `read Meeting`, this fails and the web mirror must be updated with it.
const A = 'org-a';
const B = 'org-b';
const meetingIn = (organizationId: string) => orgSubject('Meeting', { organizationId });

describe('analytics access = CASL read Meeting (web nav mirror)', () => {
  it.each(ROLES)('%s can read meetings (and so analytics) in its own org only', (role) => {
    const ability = defineAbilityFor({ userId: 'u', organizationId: A, role });
    expect(ability.can('read', meetingIn(A))).toBe(true);
    expect(ability.can('read', meetingIn(B))).toBe(false);
  });

  it('no membership (or no active org) cannot read meetings', () => {
    expect(
      defineAbilityFor({ userId: 'u', organizationId: A, role: null }).can('read', meetingIn(A)),
    ).toBe(false);
    expect(
      defineAbilityFor({ userId: 'u', organizationId: null, role: null }).can('read', meetingIn(A)),
    ).toBe(false);
  });
});
