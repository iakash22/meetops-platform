import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/stores/org-store';
import { navItems } from './nav-items';
import { OrgSwitcher } from './org-switcher';
import { SignOutControls } from './sign-out';
import { displayName, useSession } from '@/features/session/use-session';
import { VerifyEmailBanner } from '@/features/session/verify-banner';

function UserBadge() {
  const { data } = useSession();
  return (
    <div className="text-sm text-muted-foreground" aria-label="Signed in user">
      {data ? displayName(data.user) : null}
    </div>
  );
}

export function Sidebar() {
  const open = useUiStore((s) => s.sidebarOpen);
  return (
    <aside
      aria-label="Sidebar"
      data-state={open ? 'open' : 'closed'}
      className={cn(
        'scroll-area sticky top-0 flex h-screen shrink-0 flex-col border-r bg-card/60 transition-[width] duration-base ease-standard',
        open ? 'w-sidebar' : 'w-0 overflow-hidden',
      )}
    >
      <div className="brand-glow flex h-header items-center px-4 text-lg font-semibold">
        MeetOps AI
      </div>
      <Separator />
      <nav aria-label="Main" className="flex flex-col gap-1 p-2">
        {navItems.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            activeOptions={{ exact: to === '/' }}
            className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-accent-foreground [&.active]:bg-accent [&.active]:font-medium [&.active]:text-accent-foreground [&.active]:shadow-[inset_2px_0_0_hsl(var(--highlight))] [&.active_svg]:text-highlight"
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
    <header
      className="surface-glass sticky top-0 z-40 flex h-header items-center justify-between gap-4 border-b px-4"
      role="banner"
    >
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" aria-label="Toggle sidebar" onClick={toggle}>
          <Menu />
        </Button>
        <OrgSwitcher />
      </div>
      <div className="flex items-center gap-3">
        <UserBadge />
        <SignOutControls />
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
        <VerifyEmailBanner />
        <main className="mx-auto w-full max-w-content flex-1 p-4 sm:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
