import { Building2 } from 'lucide-react';
import { useOrgStore } from '@/stores/org-store';

/** Placeholder org switcher: native select until org APIs + shadcn dropdown are wired. */
export function OrgSwitcher() {
  const organizations = useOrgStore((s) => s.organizations);
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const setCurrentOrg = useOrgStore((s) => s.setCurrentOrg);

  return (
    <label className="flex items-center gap-2 text-sm">
      <Building2 className="h-4 w-4 text-muted-foreground" aria-hidden />
      <span className="sr-only">Organization</span>
      <select
        aria-label="Organization"
        className="h-8 rounded-md border border-input bg-background px-2"
        value={currentOrgId ?? ''}
        onChange={(e) => setCurrentOrg(e.target.value)}
        disabled={organizations.length === 0}
      >
        {organizations.length === 0 ? <option value="">No organization</option> : null}
        {organizations.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}
