/**
 * TEMPORARY web-local domain types.
 *
 * These belong in @meetops/contracts but do not exist there yet. They are kept
 * here (apps/web only) so the UI can be typed end to end. Once the backend adds
 * the matching contracts, delete this file and import from @meetops/contracts.
 */
export type ID = string;

export type Organization = { id: ID; name: string; slug: string };

export type User = { id: ID; email: string; name: string };

export type AuthSession = { user: User; accessToken: string; organizations: Organization[] };

export type LoginRequest = { email: string; password: string };
export type SignupRequest = { name: string; email: string; password: string };
export type ForgotPasswordRequest = { email: string };

export type Meeting = {
  id: ID;
  orgId: ID;
  title: string;
  startsAt: string;
  status: 'scheduled' | 'processing' | 'completed' | 'failed';
};

export type Task = {
  id: ID;
  orgId: ID;
  title: string;
  status: 'todo' | 'in_progress' | 'done';
  assigneeId?: ID;
  meetingId?: ID;
};

export type Project = { id: ID; orgId: ID; name: string; description?: string };

export type Paginated<T> = { items: T[]; nextCursor?: string };
