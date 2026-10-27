import type { AuthRevocationInput, RevocationPublisher } from '@meetops/session-verifier';

export type { AuthRevocationInput, RevocationPublisher };

/** Used when no Redis client is configured (dev/test without an injected client). */
export const noopRevocationPublisher: RevocationPublisher = { publish: async () => {} };

/**
 * ADR-011 section 3: publish to meetops:auth:revocations AFTER the revocation has been written.
 * Best effort: the database row is authoritative and realtime re-verifies on its interval, so a
 * Redis failure must never fail (or roll back) the request that revoked access.
 */
export async function publishRevocation(
  publisher: RevocationPublisher | undefined,
  input: AuthRevocationInput,
): Promise<void> {
  if (!publisher) return;
  try {
    await publisher.publish(input);
  } catch {
    // swallowed on purpose; see above
  }
}
