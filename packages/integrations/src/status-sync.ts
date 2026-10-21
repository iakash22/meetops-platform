import { DEFAULT_IN_PROGRESS_LABEL } from './github.js';
import type { IssueStatus } from './types.js';

export interface StatusChange {
  provider: 'github';
  /** "owner/repo#N" */
  key: string;
  status: IssueStatus;
  action: string;
}

interface IssuesEventPayload {
  action?: unknown;
  issue?: { number?: unknown; state?: unknown; state_reason?: unknown; labels?: unknown };
  label?: { name?: unknown };
  repository?: { full_name?: unknown };
}

function labelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return labels.flatMap((l) => (typeof l === 'string' ? [l] : l && typeof (l as { name?: unknown }).name === 'string' ? [(l as { name: string }).name] : []));
}

/**
 * Pure mapper: GitHub `issues` webhook event -> internal status change.
 * Returns null for non-issue events, unsupported actions or malformed payloads.
 */
export function mapGitHubIssueEvent(event: string | undefined, payload: unknown, options: { inProgressLabel?: string } = {}): StatusChange | null {
  if (event !== 'issues' || !payload || typeof payload !== 'object') return null;
  const p = payload as IssuesEventPayload;
  const action = typeof p.action === 'string' ? p.action : undefined;
  const num = p.issue?.number;
  const repo = p.repository?.full_name;
  if (!action || typeof num !== 'number' || typeof repo !== 'string') return null;
  const label = options.inProgressLabel ?? DEFAULT_IN_PROGRESS_LABEL;
  const open = p.issue?.state !== 'closed';
  const hasLabel = labelNames(p.issue?.labels).includes(label);
  let status: IssueStatus | null = null;
  switch (action) {
    case 'opened':
    case 'reopened':
      status = hasLabel ? 'in_progress' : 'open';
      break;
    case 'closed':
      status = p.issue?.state_reason === 'not_planned' ? 'closed' : 'done';
      break;
    case 'labeled':
      status = p.label?.name === label && open ? 'in_progress' : null;
      break;
    case 'unlabeled':
      status = p.label?.name === label && open ? 'open' : null;
      break;
    default:
      status = null;
  }
  return status ? { provider: 'github', key: `${repo}#${num}`, status, action } : null;
}
