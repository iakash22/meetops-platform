import { getPrismaClient, withOrgContext, type DatabaseClient, type DatabaseTransaction } from '@meetops/database';

/** The only @meetops/database imports the API uses: getPrismaClient and withOrgContext (+ types). */
export { getPrismaClient, withOrgContext, type DatabaseClient, type DatabaseTransaction };

/**
 * TODO(database P1-DB-3): replace with withUserContext(userId, fn) once exported. Until then a
 * nil org id makes every tenant_isolation policy match nothing, and app.current_user_id lets the
 * membership_self_read policy expose only the caller's own memberships.
 */
export const NIL_UUID = '00000000-0000-0000-0000-000000000000';
export function withUserContextFallback<T>(
  userId: string,
  fn: (tx: DatabaseTransaction) => Promise<T>,
  client?: DatabaseClient
): Promise<T> {
  return withOrgContext(NIL_UUID, fn, { userId, ...(client ? { client } : {}) });
}

/** Prisma unique-constraint violation, detected structurally (no @prisma/client import here). */
export const isUniqueViolation = (e: unknown) =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002';
