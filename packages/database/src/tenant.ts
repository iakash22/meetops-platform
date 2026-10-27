import type { Prisma, PrismaClient } from '@prisma/client';

/** Postgres GUC read by every RLS policy (ADR-010). */
export const ORGANIZATION_CONTEXT_SETTING = 'app.current_organization_id';
/**
 * Pre-ADR-010 GUC. Still set alongside ORGANIZATION_CONTEXT_SETTING and still read by policies as a
 * fallback for one minor version, so old code and old databases keep working during rollout.
 * @deprecated Use ORGANIZATION_CONTEXT_SETTING.
 */
export const LEGACY_ORG_CONTEXT_SETTING = 'app.current_org_id';
/** @deprecated Use ORGANIZATION_CONTEXT_SETTING. */
export const ORG_CONTEXT_SETTING = ORGANIZATION_CONTEXT_SETTING;
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
  'ai_usage_counters',
  'ai_org_config',
  'ai_idempotency',
  'transcript_chunks',
  'teams',
  'team_members',
  'consent_attestations',
  'integration_connections',
  'auth_devices',
  'auth_token_families',
  'auth_refresh_tokens',
  'notifications',
  'notification_delivery_attempts',
  'notification_preferences',
  'push_device_tokens',
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

export interface OrganizationContextOptions {
  /** Defaults to the shared singleton from getPrismaClient(). */
  client?: TransactionCapableClient | PrismaClient;
  userId?: string;
  timeoutMs?: number;
}
/** @deprecated Use OrganizationContextOptions. */
export type OrgContextOptions = OrganizationContextOptions;

/**
 * Run fn inside an interactive transaction with app.current_organization_id (and, for one minor version,
 * the legacy app.current_org_id) set LOCAL to the transaction, so RLS policies see only this organization.
 * Safe with pooled connections (settings are discarded on commit/rollback).
 */
export async function runWithOrganizationContext<T>(
  client: TransactionCapableClient | PrismaClient,
  organizationId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options: Omit<OrganizationContextOptions, 'client'> = {},
): Promise<T> {
  assertUuid(organizationId);
  if (options.userId !== undefined) assertUuid(options.userId, 'userId');
  const txOptions = options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : undefined;
  return (client as TransactionCapableClient).$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config(${ORGANIZATION_CONTEXT_SETTING}, ${organizationId}, true)`;
    await tx.$executeRaw`SELECT set_config(${LEGACY_ORG_CONTEXT_SETTING}, ${organizationId}, true)`;
    if (options.userId !== undefined) {
      await tx.$executeRaw`SELECT set_config(${USER_CONTEXT_SETTING}, ${options.userId}, true)`;
    }
    return fn(tx);
  }, txOptions);
}

/** @deprecated Use runWithOrganizationContext (ADR-010). Removed one minor version after ADR-010. */
export const runWithOrgContext = runWithOrganizationContext;

/**
 * Run fn in one interactive transaction with only app.current_user_id set LOCAL (no org).
 * Lets a user list their own memberships across orgs via the membership_self_read policy;
 * every other tenant table stays fail-closed because no organization context is set.
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
