import { useEffect, type ReactNode } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { Menu, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/stores/org-store';
import { visibleNavItems } from './nav-items';
import { OrgSwitcher } from './org-switcher';
import { SignOutControls } from './sign-out';
import { displayName, useSession } from '@/features/session/use-session';
import { VerifyEmailBanner } from '@/features/session/verify-banner';
import { UnreadBell } from '@/features/notifications/unread-bell';

/*
 * Responsive shell (docs/05-web/brand-theme.md → Layout, Follow-ups):
 * - lg+ (≥1024px): sticky sidebar that collapses to a 64px icon rail; the choice is persisted.
 * - below lg: no sidebar; the top-bar button opens the same nav in a left Sheet.
 * Which control shows is pure CSS (`lg:` utilities), so there is no matchMedia or layout shift.
 */
const SIDEBAR_ID = 'app-sidebar';
const MOBILE_NAV_ID = 'app-mobile-nav';

function UserBadge() {
  const { data } = useSession();
  return (
    <div className="hidden text-sm text-muted-foreground sm:block" aria-label="Signed in user">
      {data ? displayName(data.user) : null}
    </div>
  );
}

function NavLinks({
  collapsed = false,
  onNavigate,
}: {
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const { data: session } = useSession();
  const items = visibleNavItems(session?.role ?? null);
  return (
    <nav aria-label="Main" className="flex flex-col gap-1 p-2">
      {items.map(({ to, label, icon: Icon }) => (
        <Link
          key={to}
          to={to}
          activeOptions={{ exact: to === '/' }}
          onClick={onNavigate}
          aria-label={collapsed ? label : undefined}
          title={collapsed ? label : undefined}
          className={cn(
            'flex items-center gap-2 rounded-md py-2 text-sm text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 [&.active]:bg-accent [&.active]:font-medium [&.active]:text-accent-foreground [&.active]:shadow-[inset_2px_0_0_hsl(var(--link))] [&.active_svg]:text-link',
            collapsed ? 'justify-center px-0' : 'px-3',
          )}
        >
          <Icon className="h-4 w-4 shrink-0" aria-hidden />
          {collapsed ? null : <span className="truncate">{label}</span>}
        </Link>
      ))}
    </nav>
  );
}

/** Desktop sidebar (lg+). Hidden below lg, where `MobileNav` takes over. */
export function Sidebar() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  return (
    <aside
      id={SIDEBAR_ID}
      aria-label="Sidebar"
      data-state={collapsed ? 'collapsed' : 'open'}
      className={cn(
        'scroll-area sticky top-0 hidden h-screen shrink-0 flex-col overflow-x-hidden border-r bg-card/60 transition-[width] duration-base ease-standard motion-reduce:transition-none lg:flex',
        collapsed ? 'w-sidebar-collapsed' : 'w-sidebar',
      )}
    >
      <div
        className={cn(
          'brand-glow flex h-header shrink-0 items-center text-lg font-semibold',
          collapsed ? 'justify-center px-0' : 'px-4',
        )}
      >
        {collapsed ? (
          <>
            <span aria-hidden="true">M</span>
            <span className="sr-only">MeetOps AI</span>
          </>
        ) : (
          'MeetOps AI'
        )}
      </div>
      <Separator />
      <NavLinks collapsed={collapsed} />
    </aside>
  );
}

/** Below lg: the nav lives in a left Sheet (focus-trapped; Esc, overlay and navigation close it). */
export function MobileNav() {
  const open = useUiStore((s) => s.mobileNavOpen);
  const setOpen = useUiStore((s) => s.setMobileNavOpen);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // Close on any navigation, including back/forward, not just link clicks.
  useEffect(() => {
    setOpen(false);
  }, [pathname, setOpen]);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          aria-label="Open navigation"
          aria-controls={MOBILE_NAV_ID}
          aria-expanded={open}
        >
          <Menu />
        </Button>
      </SheetTrigger>
      <SheetContent id={MOBILE_NAV_ID} side="left" className="flex w-72 flex-col gap-0 p-0">
        <div className="brand-glow flex h-header shrink-0 items-center px-4">
          <SheetTitle className="text-lg">MeetOps AI</SheetTitle>
        </div>
        <SheetDescription className="sr-only">Main navigation</SheetDescription>
        <Separator />
        <div className="scroll-area flex-1">
          <NavLinks onNavigate={() => setOpen(false)} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function SidebarToggle() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggle = useUiStore((s) => s.toggleSidebar);
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;
  return (
    <Button
      variant="ghost"
      size="icon"
      className="hidden lg:inline-flex"
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      aria-controls={SIDEBAR_ID}
      aria-expanded={!collapsed}
      onClick={toggle}
    >
      <Icon />
    </Button>
  );
}

export function TopBar() {
  return (
    <header
      className="surface-glass sticky top-0 z-40 flex h-header items-center justify-between gap-2 border-b px-2 sm:gap-4 sm:px-4"
      role="banner"
    >
      <div className="flex min-w-0 items-center gap-2 sm:gap-3">
        <MobileNav />
        <SidebarToggle />
        <OrgSwitcher />
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        <UnreadBell />
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
