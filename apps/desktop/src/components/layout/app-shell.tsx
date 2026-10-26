import { useEffect, useState, type ReactNode } from 'react';
import {
  CalendarDays,
  ListChecks,
  Mic,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
} from 'lucide-react';

import { BrandMark } from '@/components/brand';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { activeOrganizationName, displayName, useSession } from '@/features/auth/session';

export type View = 'meetings' | 'tasks' | 'record' | 'settings';

const NAV: ReadonlyArray<{ view: View; label: string; icon: typeof CalendarDays }> = [
  { view: 'meetings', label: 'Meetings', icon: CalendarDays },
  { view: 'tasks', label: 'Tasks', icon: ListChecks },
  { view: 'record', label: 'Record', icon: Mic },
  { view: 'settings', label: 'Settings', icon: Settings },
];

/** UI preference only (no user data); safe for localStorage. */
const SIDEBAR_KEY = 'meetops.desktop.sidebarCollapsed';

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) === '1';
  } catch {
    return false;
  }
}

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
  const [collapsed, setCollapsed] = useState(readCollapsed);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
    } catch {
      // Storage unavailable: keep the in-memory preference.
    }
  }, [collapsed]);

  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <div className="flex h-full" data-testid="app-shell">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:text-sm focus:text-link focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>
      <aside
        id="app-sidebar"
        aria-label="Sidebar"
        data-collapsed={collapsed ? 'true' : 'false'}
        className={cn(
          'flex shrink-0 flex-col border-r bg-card/60 transition-[width] duration-base ease-out motion-reduce:transition-none',
          collapsed ? 'w-16' : 'w-60',
        )}
      >
        <div className={cn('flex h-14 items-center', collapsed ? 'justify-center' : 'px-4')}>
          <BrandMark compact={collapsed} />
        </div>
        <Separator />
        <nav aria-label="Main" className="flex flex-1 flex-col gap-1 p-2">
          {NAV.map(({ view: v, label, icon: Icon }) => {
            const active = v === view;
            return (
              <button
                key={v}
                type="button"
                aria-current={active ? 'page' : undefined}
                title={collapsed ? label : undefined}
                onClick={() => onNavigate(v)}
                className={cn(
                  'relative flex min-h-11 items-center gap-2 rounded-md py-2 text-left text-sm motion-safe:transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  collapsed ? 'justify-center px-0' : 'px-3',
                  active
                    ? 'bg-accent font-medium text-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-highlight'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <Icon className={cn('size-4 shrink-0', active && 'text-highlight')} aria-hidden />
                <span className={cn(collapsed && 'sr-only')}>{label}</span>
              </button>
            );
          })}
        </nav>
        <div className="p-2">
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-controls="app-sidebar"
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={cn(
              'flex min-h-11 w-full items-center gap-2 rounded-md py-2 text-sm text-muted-foreground motion-safe:transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              collapsed ? 'justify-center px-0' : 'px-3',
            )}
          >
            <ToggleIcon className="size-4 shrink-0" aria-hidden />
            {collapsed ? null : <span aria-hidden>Collapse</span>}
          </button>
        </div>
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
        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 overflow-y-auto p-6 focus:outline-none"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
