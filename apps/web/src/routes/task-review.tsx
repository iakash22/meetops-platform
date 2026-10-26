import { createRoute, lazyRouteComponent, type AnyRoute } from '@tanstack/react-router';

const TaskReviewPage = lazyRouteComponent(
  () => import('@/features/task-review/review-page'),
  'TaskReviewPage',
);

/** /tasks/review (Phase 4 approval queue), mounted under the guarded app layout by router.tsx. */
export function createTaskReviewRoutes<TParent extends AnyRoute>(getParent: () => TParent) {
  return createRoute({
    getParentRoute: getParent,
    path: '/tasks/review',
    component: TaskReviewPage,
  });
}
