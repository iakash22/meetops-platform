import { createRoute } from '@tanstack/react-router';
import { rootRoute } from './__root';

export const aboutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/about',
  component: () => <div>About MeetOps AI</div>
});
