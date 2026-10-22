import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Building2, Plus } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useOrgStore } from '@/stores/org-store';

/**
 * Organization switcher (shadcn Select). Switching clears org-scoped caches.
 * TODO(api): call the server org-switch endpoint once defined (session rotates on org switch).
 */
export function OrgSwitcher() {
  const organizations = useOrgStore((s) => s.organizations);
  const currentOrganizationId = useOrgStore((s) => s.currentOrganizationId);
  const setCurrentOrganization = useOrgStore((s) => s.setCurrentOrganization);
  const queryClient = useQueryClient();

  return (
    <div className="flex items-center gap-2 text-sm">
      <Building2 className="h-4 w-4 text-muted-foreground" aria-hidden />
      <Select
        value={currentOrganizationId ?? ''}
        onValueChange={(id) => {
          if (id === currentOrganizationId) return;
          setCurrentOrganization(id);
          void queryClient.invalidateQueries({ queryKey: ['orgs'] });
        }}
        disabled={organizations.length === 0}
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
