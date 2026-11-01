/**
 * Every lazy route chunk in src/routes. Tests render the real router, so the first
 * render of a lazy route in a test file used to pay the module's cold transform and
 * evaluation inside a single findBy (1s default), which timed out under load.
 * Importing them up front (in setup.ts beforeAll) moves that cost out of timed waits.
 * Keep in sync with the import() calls in src/routes.
 */
export const LAZY_ROUTE_SPECIFIERS = [
  '@/features/account/account-page',
  '@/features/members/members-page',
  '@/features/desktop/authorize-page',
  '@/features/auth/forms',
  '@/features/auth/email-link-pages',
  '@/features/meetings/meetings-pages',
  '@/features/tasks/tasks-page',
  '@/features/calendar/calendar-page',
  '@/features/search/search-page',
  '@/features/analytics/analytics-page',
  '@/features/notifications/notifications-page',
  '@/pages/app-pages',
  '@/features/projects/projects-page',
  '@/features/settings/settings-page',
  '@/features/teams/team-members-page',
  '@/features/organizations/create-organization',
  '@/features/extension/pair-page',
  '@/features/task-review/review-page',
] as const;

// Literal import() calls so Vite resolves the aliases.
export const LAZY_ROUTE_MODULES = [
  () => import('@/features/account/account-page'),
  () => import('@/features/members/members-page'),
  () => import('@/features/desktop/authorize-page'),
  () => import('@/features/auth/forms'),
  () => import('@/features/auth/email-link-pages'),
  () => import('@/features/meetings/meetings-pages'),
  () => import('@/features/tasks/tasks-page'),
  () => import('@/features/calendar/calendar-page'),
  () => import('@/features/search/search-page'),
  () => import('@/features/analytics/analytics-page'),
  () => import('@/features/notifications/notifications-page'),
  () => import('@/pages/app-pages'),
  () => import('@/features/projects/projects-page'),
  () => import('@/features/settings/settings-page'),
  () => import('@/features/teams/team-members-page'),
  () => import('@/features/organizations/create-organization'),
  () => import('@/features/extension/pair-page'),
  () => import('@/features/task-review/review-page'),
] as const;

export async function preloadLazyRoutes(): Promise<void> {
  await Promise.all(LAZY_ROUTE_MODULES.map((load) => load()));
}
