import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime } from '../common.js';

/**
 * Reference to a human approval for an external write (e.g. creating an issue in GitHub or Jira), matching INT
 * `guardedWrite` (PR #19). `payloadHash` is the lowercase sha256 hex of the canonical JSON of the approved
 * operation. Integrations must verify that the org and hash match before any credential lookup or network call.
 */
export const WriteApproval = Type.Object(
  {
    approvalId: Id,
    organizationId: Id,
    approverUserId: Id,
    payloadHash: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    approvedAt: Type.Optional(IsoDateTime),
  },
  { additionalProperties: false },
);
export type WriteApproval = Static<typeof WriteApproval>;
