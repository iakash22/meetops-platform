import {
  getPrismaClient,
  withOrgContext,
  withUserContext,
  type DatabaseClient,
  type DatabaseTransaction
} from '@meetops/database';

/** The only @meetops/database runtime imports the API uses (plus types). */
export { getPrismaClient, withOrgContext, withUserContext, type DatabaseClient, type DatabaseTransaction };

/** Prisma unique-constraint violation, detected structurally (no @prisma/client import here). */
export const isUniqueViolation = (e: unknown) =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002';
