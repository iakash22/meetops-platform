import {
  Bell,
  CheckSquare,
  FolderKanban,
  LayoutDashboard,
  Settings,
  UserRound,
  Users,
  Video,
  type LucideIcon,
} from 'lucide-react';

export type NavItem = {
  to:
    | '/'
    | '/meetings'
    | '/tasks'
    | '/notifications'
    | '/projects'
    | '/organization/members'
    | '/account'
    | '/settings';
  label: string;
  icon: LucideIcon;
};

export const navItems: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/meetings', label: 'Meetings', icon: Video },
  { to: '/tasks', label: 'Tasks', icon: CheckSquare },
  { to: '/notifications', label: 'Notifications', icon: Bell },
  { to: '/projects', label: 'Projects', icon: FolderKanban },
  { to: '/organization/members', label: 'Members', icon: Users },
  { to: '/account', label: 'Account', icon: UserRound },
  { to: '/settings', label: 'Settings', icon: Settings },
];
