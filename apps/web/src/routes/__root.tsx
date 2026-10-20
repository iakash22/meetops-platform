import { createRootRoute, Link, Outlet } from '@tanstack/react-router';

export const rootRoute = createRootRoute({
  component: () => (
    <div className="p-6">
      <div className="mb-4 text-2xl font-bold">MeetOps AI</div>
      <nav className="space-x-4 mb-6">
        <Link to="/" className="[&.active]:font-semibold">
          Home
        </Link>
        <Link to="/about" className="[&.active]:font-semibold">
          About
        </Link>
      </nav>
      <Outlet />
    </div>
  )
});
