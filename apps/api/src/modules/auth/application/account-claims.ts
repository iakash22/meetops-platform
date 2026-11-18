import type { UserRepository } from '../../users/domain/user.repository.js';
import type { SessionRepository } from '../domain/session.js';
import type { AccountClaimStore } from '../domain/ports.js';

/** ADR-021 OQ-15: the slice of the MFA store a takeover claim needs (structural, so auth does not import mfa). */
export interface ClaimMfaWiper {
  deleteAllForUser(userId: string): Promise<void>;
}

/**
 * AccountClaimStore over the two repository ports, for stores without a shared transaction (in-memory dev/test, or a
 * mixed setup). Revoke, then change the row, then revoke again: a failure before the change leaves the account
 * untouched (the next attempt redoes everything), and a session opened between the two revocations is still caught.
 * Production wiring uses the Prisma store, which does the change and the revocation in one transaction.
 */
export function sequentialAccountClaims(
  users: UserRepository,
  sessions: SessionRepository,
  mfa?: ClaimMfaWiper,
): AccountClaimStore {
  const run = async (userId: string, at: Date, change: () => Promise<boolean>) => {
    await sessions.revokeAllForUser(userId, at);
    if (!(await change())) return false;
    // OQ-15: the claimed account starts without any factor, pending enrolment or recovery code.
    await mfa?.deleteAllForUser(userId);
    await sessions.revokeAllForUser(userId, at);
    return true;
  };
  return {
    claimForGoogle: (userId, sub, at) =>
      run(userId, at, () => users.claimUnverifiedForGoogle(userId, sub, at)),
    claimForMailbox: (userId, at) =>
      run(userId, at, () => users.claimUnverifiedForMailbox(userId, at, { clearPassword: true })),
  };
}
