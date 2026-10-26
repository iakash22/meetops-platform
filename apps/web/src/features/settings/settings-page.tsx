import { lazy, Suspense } from 'react';
import { Link } from '@tanstack/react-router';
import { LoadingState } from '@/components/states/states';
import { useCanManageConsentSettings } from './consent-gate';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/pages/resource-list';
import { EmployeesPanel } from '@/features/employees/employees-panel';
import { TeamsPanel } from '@/features/teams/teams-panel';
import { IntegrationsPanel } from '@/features/integrations/integrations-panel';

import { SETTINGS_TABS, type SettingsTab } from './settings-search';
export {
  SETTINGS_TABS,
  parseSettingsSearch,
  type SettingsSearch,
  type SettingsTab,
} from './settings-search';

const LABELS: Record<SettingsTab, string> = {
  employees: 'Employees',
  teams: 'Teams',
  integrations: 'Integrations',
  consent: 'Consent',
};

// Owner/admin only, so it is split out of the settings chunk.
const ConsentSettingsPanel = lazy(() =>
  import('./consent-settings-panel').then((m) => ({ default: m.ConsentSettingsPanel })),
);

export function SettingsPage({ tab: requested = 'employees' }: { tab?: SettingsTab | undefined }) {
  const canConsent = useCanManageConsentSettings();
  const tab = requested === 'consent' && !canConsent ? 'employees' : requested;
  const tabs = SETTINGS_TABS.filter((t) => t !== 'consent' || canConsent);
  return (
    <>
      <PageHeader
        title="Settings"
        description="Organization directory, teams, integrations and recording consent"
      />
      <nav aria-label="Settings sections" className="mb-6 flex gap-2 border-b">
        {tabs.map((t) => (
          <Link
            key={t}
            to="/settings"
            search={{ tab: t }}
            aria-current={t === tab ? 'page' : undefined}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium',
              t === tab
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {LABELS[t]}
          </Link>
        ))}
      </nav>
      {tab === 'consent' ? (
        <Suspense fallback={<LoadingState label="Loading consent settings…" />}>
          <ConsentSettingsPanel />
        </Suspense>
      ) : tab === 'teams' ? (
        <TeamsPanel />
      ) : tab === 'integrations' ? (
        <IntegrationsPanel />
      ) : (
        <EmployeesPanel />
      )}
    </>
  );
}
