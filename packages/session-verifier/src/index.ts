import { createPrismaSessionStore } from './prisma-store.js';
import { createSessionVerifier, type SessionVerifier } from './verifier.js';
import type { VerifiedSession, VerifyByHashInput, VerifyInput } from './types.js';

export { hashToken, TOKEN_HASH_PATTERN, TOKEN_HASH_TEST_VECTORS } from './hash.js';
export {
  createSessionVerifier,
  DEFAULT_IDLE_TIMEOUT_MS,
  EXTENSION_AUDIENCE,
  MAX_CREDENTIAL_LENGTH,
  type SessionVerifier,
  type SessionVerifierOptions,
} from './verifier.js';
export { createPrismaSessionStore } from './prisma-store.js';
export type {
  Clock,
  CredentialKind,
  ExtensionTokenRecord,
  ExtensionTokenStore,
  MembershipRecord,
  SessionRecord,
  SessionStore,
  VerifiedSession,
  VerifyByHashInput,
  VerifyInput,
} from './types.js';
export {
  AUTH_REVOCATION_MESSAGE_VERSION,
  AUTH_REVOCATION_REASONS,
  AUTH_REVOCATIONS_CHANNEL,
  buildRevocationMessage,
  createRedisRevocationPublisher,
  parseRevocationMessage,
  type AuthRevocationInput,
  type AuthRevocationMessage,
  type AuthRevocationReason,
  type RedisPublisher,
  type RevocationPublisher,
} from './revocations.js';

let shared: SessionVerifier | undefined;
const defaultVerifier = () =>
  (shared ??= createSessionVerifier({ sessions: createPrismaSessionStore() }));

/**
 * ADR-011 section 2.2, over the shared @meetops/database client with default options (no extension token
 * store, so bearers return null). Use createSessionVerifier to pass a store, clock or idle timeout.
 */
export function verifySession(input: VerifyInput): Promise<VerifiedSession | null> {
  return defaultVerifier().verifySession(input);
}

/** ADR-011 section 5.3: re-verify from the credential hash kept in socket.data. */
export function verifySessionByHash(input: VerifyByHashInput): Promise<VerifiedSession | null> {
  return defaultVerifier().verifySessionByHash(input);
}
