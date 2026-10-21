import type { Issue } from './types.js';

/**
 * Local mirror of `IntegrationIssue` from @meetops/contracts (PR #17, feat/core-contracts).
 * TODO(P1-INT-3): once #17 is merged to main, delete this interface and
 * `import type { IntegrationIssue } from '@meetops/contracts'` (shape is identical).
 */
export interface IntegrationIssueRecord {
  id: string;
  taskId: string;
  /** Integration key, e.g. "jira", "github". */
  integration: string;
  externalId: string;
  externalUrl?: string;
  syncedAt?: string;
  createdAt: string;
}

/** Provider Issue -> persisted link record. Uses the provider key ("owner/repo#N" / "PROJ-1") as externalId. */
export function toIntegrationIssue(
  issue: Issue,
  ctx: { id: string; taskId: string; now?: Date; createdAt?: string }
): IntegrationIssueRecord {
  const now = (ctx.now ?? new Date()).toISOString();
  return {
    id: ctx.id,
    taskId: ctx.taskId,
    integration: issue.provider,
    externalId: issue.key,
    externalUrl: issue.url,
    syncedAt: now,
    createdAt: ctx.createdAt ?? now
  };
}

/** Link record -> provider lookup reference (for getIssue/updateStatus). */
export function fromIntegrationIssue(record: IntegrationIssueRecord): { provider: string; key: string } {
  return { provider: record.integration, key: record.externalId };
}
