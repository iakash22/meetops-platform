import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/stores/org-store';
import { navItems } from './nav-items';
import { OrgSwitcher } from './org-switcher';

export function Sidebar() {
  const open = useUiStore((s) => s.sidebarOpen);
  return (
    <aside
      aria-label="Sidebar"
      data-state={open ? 'open' : 'closed'}
      className={cn('flex shrink-0 flex-col border-r bg-muted/40 transition-all', open ? 'w-60' : 'w-0 overflow-hidden')}
    >
      <div className="flex h-14 items-center px-4 text-lg font-semibold">MeetOps AI</div>
      <Separator />
      <nav aria-label="Main" className="flex flex-col gap-1 p-2">
        {navItems.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            activeOptions={{ exact: to === '/' }}
            className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground [&.active]:bg-accent [&.active]:font-medium [&.active]:text-accent-foreground"
          >
            <Icon className="h-4 w-4" aria-hidden />
            {label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}

export function TopBar() {
  const toggle = useUiStore((s) => s.toggleSidebar);
  return (
    <header className="flex h-14 items-center justify-between gap-4 border-b px-4" role="banner">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" aria-label="Toggle sidebar" onClick={toggle}>
          <Menu />
        </Button>
        <OrgSwitcher />
      </div>
      <div className="text-sm text-muted-foreground" aria-label="User menu">
        {/* TODO: user menu once auth session contract exists */}
        Account
      </div>
    </header>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen" data-testid="app-shell">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
