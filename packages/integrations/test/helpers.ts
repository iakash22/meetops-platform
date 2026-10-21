import { vi } from 'vitest';
import { computeWritePayloadHash, type AuditEvent, type WriteOperation } from '../src';

export const ORG = 'org_1';
export const INTEGRATION = 'int_1';

export function governance(verifyResult = true) {
  const events: AuditEvent[] = [];
  const approvals = { verify: vi.fn(async () => verifyResult) };
  const audit = { record: vi.fn(async (e: AuditEvent) => void events.push(e)) };
  return { approvals, audit, events };
}

export function approvalFor(provider: string, operation: WriteOperation, payload: unknown, over: Record<string, unknown> = {}) {
  return {
    approvalId: 'apr_1',
    organizationId: ORG,
    approverUserId: 'usr_1',
    payloadHash: computeWritePayloadHash(operation, { provider, organizationId: ORG, integrationId: INTEGRATION }, payload),
    ...over
  };
}
