import type { Id } from '@meetops/contracts';

export const consentSettingsQueryKey = (organizationId: Id) =>
  ['orgs', organizationId, 'settings', 'consent'] as const;
