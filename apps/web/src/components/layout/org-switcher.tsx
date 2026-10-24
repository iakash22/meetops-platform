import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { GetAuthSessionResponse } from '@meetops/contracts';
import { Link } from '@tanstack/react-router';
import { Building2, Plus } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { describeError } from '@/lib/api/error-messages';
import { useApi } from '@/lib/api/context';
import { queryKeys } from '@/lib/api/queries';
import { applySessionToStore } from '@/features/session/use-session';
import { useOrgStore } from '@/stores/org-store';

/**
 * Organization switcher (shadcn Select). Switching calls POST /auth/switch-org
 * (session + CSRF rotate; the client reuses the returned csrfToken), refreshes the
 * session and refetches org-scoped data. On failure the previous org stays selected.
 */
export function OrgSwitcher() {
  const organizations = useOrgStore((s) => s.organizations);
  const currentOrganizationId = useOrgStore((s) => s.currentOrganizationId);
  const setCurrentOrganization = useOrgStore((s) => s.setCurrentOrganization);
  const queryClient = useQueryClient();
  const api = useApi();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const switchTo = async (organizationId: string) => {
    if (organizationId === currentOrganizationId || pending) return;
    setPending(true);
    setError(null);
    try {
      const { csrfToken: _csrf, ...session } = await api.auth.switchOrganization({
        organizationId,
      });
      void _csrf;
      queryClient.setQueryData<GetAuthSessionResponse | null>(queryKeys.session, session);
      applySessionToStore(session);
      setCurrentOrganization(session.activeOrganizationId ?? organizationId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.session }),
        queryClient.invalidateQueries({ queryKey: ['orgs'] }),
      ]);
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex items-center gap-2 text-sm">
      <Building2 className="h-4 w-4 text-muted-foreground" aria-hidden />
      <Select
        value={currentOrganizationId ?? ''}
        onValueChange={(id) => void switchTo(id)}
        disabled={organizations.length === 0 || pending}
      >
        <SelectTrigger className="h-8 w-48" aria-label="Organization">
          <SelectValue placeholder="No organization" />
        </SelectTrigger>
        <SelectContent>
          {organizations.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {describeError(error).message}
        </span>
      ) : null}
      {/* Kept outside the Select so the switcher stays disabled when there are no orgs (E2E-06). */}
      <Link
        to="/organizations/new"
        aria-label="Create organization"
        title="Create organization"
        className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-accent"
      >
        <Plus className="h-4 w-4" aria-hidden />
      </Link>
    </div>
  );
}
