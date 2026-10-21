import { PrismaClient, type Prisma } from '@prisma/client';
import { runWithOrgContext, runWithUserContext, type OrgContextOptions } from './tenant.js';

/** The database client type. Model/enum types come from @meetops/contracts, not from here. */
export type DatabaseClient = PrismaClient;
/** Transaction-scoped client passed to withOrgContext callbacks. */
export type DatabaseTransaction = Prisma.TransactionClient;
export type { OrgContextOptions };

export interface CreatePrismaClientOptions {
  /** Overrides DATABASE_URL for this client. */
  databaseUrl?: string;
  log?: Prisma.LogLevel[];
}

/** Create a new PrismaClient. Prefer getPrismaClient() in app code. */
export function createPrismaClient(options: CreatePrismaClientOptions = {}): DatabaseClient {
  const config: Prisma.PrismaClientOptions = {};
  if (options.databaseUrl) config.datasources = { db: { url: options.databaseUrl } };
  if (options.log) config.log = options.log;
  return new PrismaClient(config);
}

const globalForPrisma = globalThis as unknown as { __meetopsPrisma?: DatabaseClient };

/** Process-wide singleton (survives dev hot reload). Reads DATABASE_URL lazily on first query. */
export function getPrismaClient(options: CreatePrismaClientOptions = {}): DatabaseClient {
  globalForPrisma.__meetopsPrisma ??= createPrismaClient(options);
  return globalForPrisma.__meetopsPrisma;
}

/** Disconnect and clear the singleton (for graceful shutdown and tests). */
export async function disconnectPrismaClient(): Promise<void> {
  const client = globalForPrisma.__meetopsPrisma;
  if (client) {
    delete globalForPrisma.__meetopsPrisma;
    await client.$disconnect();
  }
}

/**
 * withOrgContext(orgId, fn, { client?, userId?, timeoutMs? }): run fn in one interactive
 * transaction with app.current_org_id set LOCAL, so forced RLS only exposes this org.
 * Uses the shared client unless one is passed.
 */
export async function withOrgContext<T>(
  orgId: string,
  fn: (tx: DatabaseTransaction) => Promise<T>,
  options: OrgContextOptions = {},
): Promise<T> {
  const { client, ...rest } = options;
  return runWithOrgContext(client ?? getPrismaClient(), orgId, fn, rest);
}

/**
 * withUserContext(userId, fn, { client?, timeoutMs? }): run fn in one transaction with
 * app.current_user_id set LOCAL, for cross-org reads of the user's own memberships.
 */
export async function withUserContext<T>(
  userId: string,
  fn: (tx: DatabaseTransaction) => Promise<T>,
  options: Pick<OrgContextOptions, 'client' | 'timeoutMs'> = {},
): Promise<T> {
  const { client, ...rest } = options;
  return runWithUserContext(client ?? getPrismaClient(), userId, fn, rest);
}
