import {
  BarChart3,
  Bell,
  CalendarDays,
  Search,
  CheckSquare,
  FolderKanban,
  LayoutDashboard,
  Settings,
  UserRound,
  Users,
  Video,
  type LucideIcon,
} from 'lucide-react';
import type { Role } from '@meetops/contracts';
import { canViewAnalytics } from '@/features/analytics/permissions';

export type NavItem = {
  to:
    | '/'
    | '/meetings'
    | '/tasks'
    | '/calendar'
    | '/search'
    | '/analytics'
    | '/notifications'
    | '/projects'
    | '/organization/members'
    | '/account'
    | '/settings';
  label: string;
  icon: LucideIcon;
  /**
   * Show the entry only when the caller's role in the active org passes this check. Use the same
   * permission helper the page uses, so the nav and the route agree. Omitted: always shown.
   */
  visibleFor?: (role: Role | null) => boolean;
};

export const navItems: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/meetings', label: 'Meetings', icon: Video },
  { to: '/tasks', label: 'Tasks', icon: CheckSquare },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays },
  { to: '/search', label: 'Search', icon: Search },
  { to: '/analytics', label: 'Analytics', icon: BarChart3, visibleFor: canViewAnalytics },
  { to: '/notifications', label: 'Notifications', icon: Bell },
  { to: '/projects', label: 'Projects', icon: FolderKanban },
  { to: '/organization/members', label: 'Members', icon: Users },
  { to: '/account', label: 'Account', icon: UserRound },
  { to: '/settings', label: 'Settings', icon: Settings },
];

/** The nav entries for `role` (the session's role in the active org; null = no membership). */
export function visibleNavItems(role: Role | null): NavItem[] {
  return navItems.filter((item) => !item.visibleFor || item.visibleFor(role));
}
