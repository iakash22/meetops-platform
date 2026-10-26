import { useSession } from '@/features/session/use-session';
import { useOrganizationId } from '@/lib/api/queries';
import { CONSENT_SETTINGS_WRITE_ROLES } from '@/features/uploads/types';

/**
 * Mirrors the API's CASL rule for consent settings (PATCH: CONSENT_SETTINGS_WRITE_ROLES).
 * UI hint only; the API enforces it (403 otherwise). Role applies to the session's active org.
 */
export function useCanManageConsentSettings(): boolean {
  const { data } = useSession();
  const orgId = useOrganizationId();
  if (!data || data.activeOrganizationId !== orgId) return false;
  return (CONSENT_SETTINGS_WRITE_ROLES as readonly string[]).includes(data.role ?? '');
}
