import {
  CheckSquare,
  FolderKanban,
  LayoutDashboard,
  Settings,
  Video,
  type LucideIcon,
} from 'lucide-react';

export type NavItem = {
  to: '/' | '/meetings' | '/tasks' | '/projects' | '/settings';
  label: string;
  icon: LucideIcon;
};

export const navItems: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/meetings', label: 'Meetings', icon: Video },
  { to: '/tasks', label: 'Tasks', icon: CheckSquare },
  { to: '/projects', label: 'Projects', icon: FolderKanban },
  { to: '/settings', label: 'Settings', icon: Settings },
];
