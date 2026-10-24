import { vi } from 'vitest';
import { computeWritePayloadHash, type AuditEvent, type WriteOperation } from '../src';

export const ORG = '0b6f3a52-6a0e-4d1f-9c55-2f4c6f0e1a01';
export const OTHER_ORG = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
export const APPROVAL_ID = '3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a';
export const APPROVER = 'e4774cdd-a079-4f86-814e-8b9140bb6db4';
export const INTEGRATION = '5f6e7d8c-9b0a-4c1d-8e2f-3a4b5c6d7e8f';

export function governance(verifyResult = true) {
  const events: AuditEvent[] = [];
  const approvals = { verify: vi.fn(async () => verifyResult) };
  const audit = { record: vi.fn(async (e: AuditEvent) => void events.push(e)) };
  return { approvals, audit, events };
}

export function approvalFor(provider: string, operation: WriteOperation, payload: unknown, over: Record<string, unknown> = {}) {
  return {
    approvalId: APPROVAL_ID,
    organizationId: ORG,
    approverUserId: APPROVER,
    payloadHash: computeWritePayloadHash(operation, { provider, organizationId: ORG, integrationId: INTEGRATION }, payload),
    ...over
  };
}
