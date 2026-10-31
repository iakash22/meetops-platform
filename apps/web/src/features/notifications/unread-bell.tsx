import { Link } from '@tanstack/react-router';
import { Bell } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { useUnreadNotifications } from './queries';

/** Top-bar bell. Count comes from GET ?unreadOnly=true (no unreadCount in the contract). */
export function UnreadBell() {
  const { data } = useUnreadNotifications();
  const count = data?.items?.length ?? 0;
  const label = count > 0 ? `Notifications, ${count > 99 ? '99+' : count} unread` : 'Notifications';
  return (
    <Link
      to="/notifications"
      aria-label={label}
      className={buttonVariants({ variant: 'ghost', size: 'icon', className: 'relative' })}
    >
      <Bell aria-hidden />
      {count > 0 ? (
        <span
          data-testid="unread-count"
          className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground"
        >
          {count > 99 ? '99+' : count}
        </span>
      ) : null}
    </Link>
  );
}
