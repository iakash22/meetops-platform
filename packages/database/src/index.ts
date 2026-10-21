import { PrismaClient, type Prisma } from '@prisma/client';

export * from '@prisma/client';
export * from './tenant.js';

import { runWithOrgContext, type OrgContextOptions } from './tenant.js';

export type DatabaseClient = PrismaClient;

export interface CreatePrismaClientOptions {
  /** Overrides DATABASE_URL for this client. */
  databaseUrl?: string;
  log?: Prisma.LogLevel[];
}

/** Create a new PrismaClient. Prefer getPrismaClient() in app code. */
export function createPrismaClient(options: CreatePrismaClientOptions = {}): PrismaClient {
  const config: Prisma.PrismaClientOptions = {};
  if (options.databaseUrl) config.datasources = { db: { url: options.databaseUrl } };
  if (options.log) config.log = options.log;
  return new PrismaClient(config);
}

const globalForPrisma = globalThis as unknown as { __meetopsPrisma?: PrismaClient };

/** Process-wide singleton (survives dev hot reload). Reads DATABASE_URL lazily on first query. */
export function getPrismaClient(options: CreatePrismaClientOptions = {}): PrismaClient {
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
 * withOrgContext(orgId, fn, { client?, userId?, timeoutMs? }): run fn in a transaction scoped to orgId
 * for Postgres RLS. Uses the shared client unless one is passed.
 */
export async function withOrgContext<T>(
  orgId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options: OrgContextOptions = {},
): Promise<T> {
  const { client, ...rest } = options;
  return runWithOrgContext(client ?? getPrismaClient(), orgId, fn, rest);
}
