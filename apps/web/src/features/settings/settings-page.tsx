import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/pages/resource-list';
import { EmployeesPanel } from '@/features/employees/employees-panel';
import { TeamsPanel } from '@/features/teams/teams-panel';

export const SETTINGS_TABS = ['employees', 'teams'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];
export type SettingsSearch = { tab?: SettingsTab };

/** `?tab=` is untrusted: anything but a known tab falls back to the default. */
export function parseSettingsSearch(search: Record<string, unknown>): SettingsSearch {
  const tab = SETTINGS_TABS.find((t) => t === search.tab);
  return tab ? { tab } : {};
}

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
