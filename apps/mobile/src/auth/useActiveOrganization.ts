import type { Organization, Role } from '@meetops/contracts';

import { useAuth } from './AuthProvider';

export interface ActiveOrganization {
  organization: Organization | null;
  organizationId: string | null;
  role: Role | null;
}

/** Active organization of the signed-in user (all nulls when signed out). */
export function useActiveOrganization(): ActiveOrganization {
  const { state } = useAuth();
  if (state.status !== 'signedIn') return { organization: null, organizationId: null, role: null };
  const organizationId = state.identity.organizationId;
  return {
    organizationId,
    organization: state.session.organizations.find((o) => o.id === organizationId) ?? null,
    role: state.session.role,
  };
}
