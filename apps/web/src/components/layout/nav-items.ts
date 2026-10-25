import {
  CheckSquare,
  FolderKanban,
  LayoutDashboard,
  Settings,
  UserRound,
  Video,
  type LucideIcon,
} from 'lucide-react';

export type NavItem = {
  to: '/' | '/meetings' | '/tasks' | '/projects' | '/account' | '/settings';
  label: string;
  icon: LucideIcon;
};

export const navItems: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/meetings', label: 'Meetings', icon: Video },
  { to: '/tasks', label: 'Tasks', icon: CheckSquare },
  { to: '/projects', label: 'Projects', icon: FolderKanban },
  { to: '/account', label: 'Account', icon: UserRound },
  { to: '/settings', label: 'Settings', icon: Settings },
];
