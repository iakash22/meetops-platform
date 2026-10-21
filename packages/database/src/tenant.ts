import type { Prisma, PrismaClient } from '@prisma/client';

/** Postgres GUC read by every RLS policy. */
export const ORG_CONTEXT_SETTING = 'app.current_org_id';
/** Optional GUC for user-scoped reads (e.g. listing own memberships before an org is chosen). */
export const USER_CONTEXT_SETTING = 'app.current_user_id';

/** Tables protected by forced RLS keyed on org_id. Global tables: organizations, users, sessions. */
export const TENANT_TABLES = [
  'memberships',
  'invitations',
  'employees',
  'projects',
  'meetings',
  'meeting_participants',
  'file_objects',
  'transcripts',
  'transcript_segments',
  'reports',
  'extracted_tasks',
  'task_approvals',
  'tasks',
  'integration_issues',
  'ai_runs',
  'outbox_events',
  'audit_events',
  'recordings',
  'recording_sessions',
  'recording_session_chunks',
] as const;
export type TenantTable = (typeof TENANT_TABLES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(value: string, label = 'organizationId'): void {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new TypeError(`${label} must be a UUID`);
  }
}

/** Minimal client surface needed; satisfied by PrismaClient and test doubles. */
export interface TransactionCapableClient {
  $transaction<R>(
    fn: (tx: Prisma.TransactionClient) => Promise<R>,
    options?: {
      maxWait?: number;
      timeout?: number;
      isolationLevel?: Prisma.TransactionIsolationLevel;
    },
  ): Promise<R>;
}

export interface OrgContextOptions {
  /** Defaults to the shared singleton from getPrismaClient(). */
  client?: TransactionCapableClient | PrismaClient;
  userId?: string;
  timeoutMs?: number;
}

/**
 * Run fn inside an interactive transaction with app.current_org_id set LOCAL to the transaction,
 * so RLS policies see only this org. Safe with pooled connections (setting is discarded on commit/rollback).
 */
export async function runWithOrgContext<T>(
  client: TransactionCapableClient | PrismaClient,
  organizationId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options: Omit<OrgContextOptions, 'client'> = {},
): Promise<T> {
  assertUuid(organizationId);
  if (options.userId !== undefined) assertUuid(options.userId, 'userId');
  const txOptions = options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : undefined;
  return (client as TransactionCapableClient).$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config(${ORG_CONTEXT_SETTING}, ${organizationId}, true)`;
    if (options.userId !== undefined) {
      await tx.$executeRaw`SELECT set_config(${USER_CONTEXT_SETTING}, ${options.userId}, true)`;
    }
    return fn(tx);
  }, txOptions);
}

/**
 * Run fn in one interactive transaction with only app.current_user_id set LOCAL (no org).
 * Lets a user list their own memberships across orgs via the membership_self_read policy;
 * every other tenant table stays fail-closed because app.current_org_id is unset.
 */
export async function runWithUserContext<T>(
  client: TransactionCapableClient | PrismaClient,
  userId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  assertUuid(userId, 'userId');
  const txOptions = options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : undefined;
  return (client as TransactionCapableClient).$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config(${USER_CONTEXT_SETTING}, ${userId}, true)`;
    return fn(tx);
  }, txOptions);
}
