import type { ReactNode } from 'react';
import { CalendarDays, Settings } from 'lucide-react';

import { BrandMark } from '@/components/brand';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { activeOrganizationName, displayName, useSession } from '@/features/auth/session';

export type View = 'meetings' | 'settings';

const NAV: ReadonlyArray<{ view: View; label: string; icon: typeof CalendarDays }> = [
  { view: 'meetings', label: 'Meetings', icon: CalendarDays },
  { view: 'settings', label: 'Settings', icon: Settings },
];

export function AppShell({
  view,
  onNavigate,
  children,
}: {
  view: View;
  onNavigate: (view: View) => void;
  children: ReactNode;
}) {
  const { session } = useSession();
  return (
    <div className="flex h-full" data-testid="app-shell">
      <aside aria-label="Sidebar" className="flex w-56 shrink-0 flex-col border-r bg-surface">
        <div className="flex h-14 items-center px-4">
          <BrandMark />
        </div>
        <Separator />
        <nav aria-label="Main" className="flex flex-col gap-1 p-2">
          {NAV.map(({ view: v, label, icon: Icon }) => {
            const active = v === view;
            return (
              <button
                key={v}
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => onNavigate(v)}
                className={cn(
                  'relative flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'bg-surface-2 font-medium text-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-accent'
                    : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground',
                )}
              >
                <Icon className={cn('size-4', active && 'text-accent')} aria-hidden />
                {label}
              </button>
            );
          })}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between gap-4 border-b px-6">
          <span className="text-sm font-medium">
            {session ? activeOrganizationName(session) : null}
          </span>
          <span className="text-sm text-muted-foreground" aria-label="Signed in user">
            {session ? displayName(session) : null}
          </span>
        </header>
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
