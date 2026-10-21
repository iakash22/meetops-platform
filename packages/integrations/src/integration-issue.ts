import { Value } from '@sinclair/typebox/value';
import { IntegrationIssueRecord as IntegrationIssueRecordSchema, type IntegrationIssueRecord, type IntegrationProvider } from '@meetops/contracts';
import { IssueTrackerError, type Issue, type IssueStatus } from './types.js';

export type { IntegrationIssueRecord, IntegrationProvider };

export interface ToIntegrationIssueContext {
  /** Record id (uuid). */
  id: string;
  organizationId: string;
  integrationId: string;
  taskId: string;
  now?: Date;
  /** Preserve original createdAt when re-syncing an existing link. */
  createdAt?: string;
}

/**
 * Provider Issue -> tenant-scoped persisted link record (contracts IntegrationIssueRecord).
 * externalId = provider key ("owner/repo#N" / "PROJ-1"); lastKnownStatus = issue.status; externalUrl only if https.
 * The result is validated against the contract schema; invalid input throws IssueTrackerError.
 */
export function toIntegrationIssue(issue: Issue, ctx: ToIntegrationIssueContext): IntegrationIssueRecord {
  const now = (ctx.now ?? new Date()).toISOString();
  const record: IntegrationIssueRecord = {
    id: ctx.id,
    organizationId: ctx.organizationId,
    integrationId: ctx.integrationId,
    taskId: ctx.taskId,
    provider: issue.provider,
    externalId: issue.key,
    lastKnownStatus: issue.status,
    syncedAt: now,
    createdAt: ctx.createdAt ?? now
  };
  if (/^https:\/\//i.test(issue.url)) record.externalUrl = issue.url;
  if (!Value.Check(IntegrationIssueRecordSchema, record)) {
    const first = Value.Errors(IntegrationIssueRecordSchema, record).First();
    throw new IssueTrackerError(`Invalid IntegrationIssueRecord${first ? ` at ${first.path}` : ''}`, issue.provider);
  }
  return record;
}

/** Link record -> lookup reference for the provider bound to (organizationId, integrationId). */
export function fromIntegrationIssue(record: IntegrationIssueRecord): {
  organizationId: string;
  integrationId: string;
  provider: IntegrationProvider;
  key: string;
  lastKnownStatus?: IssueStatus;
} {
  const ref: ReturnType<typeof fromIntegrationIssue> = {
    organizationId: record.organizationId,
    integrationId: record.integrationId,
    provider: record.provider,
    key: record.externalId
  };
  if (record.lastKnownStatus) ref.lastKnownStatus = record.lastKnownStatus;
  return ref;
}
