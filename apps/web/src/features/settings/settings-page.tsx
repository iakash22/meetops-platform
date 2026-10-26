import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/pages/resource-list';
import { EmployeesPanel } from '@/features/employees/employees-panel';
import { TeamsPanel } from '@/features/teams/teams-panel';

import { SETTINGS_TABS, type SettingsTab } from './settings-search';
export {
  SETTINGS_TABS,
  parseSettingsSearch,
  type SettingsSearch,
  type SettingsTab,
} from './settings-search';

const LABELS: Record<SettingsTab, string> = { employees: 'Employees', teams: 'Teams' };

export function SettingsPage({ tab = 'employees' }: { tab?: SettingsTab | undefined }) {
  return (
    <>
      <PageHeader title="Settings" description="Organization directory: people and teams" />
      <nav aria-label="Settings sections" className="mb-6 flex gap-2 border-b">
        {SETTINGS_TABS.map((t) => (
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
      {tab === 'teams' ? <TeamsPanel /> : <EmployeesPanel />}
    </>
  );
}
