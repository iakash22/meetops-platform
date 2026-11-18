import { randomBytes } from 'node:crypto';
import { LocalKeyProvider, TokenCipher } from '@meetops/integrations';
import type { DatabaseClient } from '../../shared/prisma/context.js';
import type { UserRepository } from '../users/domain/user.repository.js';
import type { MfaRepository } from './domain/mfa.repository.js';
import { InMemoryMfaRepository } from './infrastructure/in-memory-mfa.repository.js';
import { PrismaMfaRepository } from './infrastructure/prisma-mfa.repository.js';
import type { MfaSecretCipher } from './application/mfa.service.js';

export { MfaService, type MfaSecretCipher } from './application/mfa.service.js';
export { mfaRoutes } from './http/mfa.routes.js';
export { InMemoryMfaRepository } from './infrastructure/in-memory-mfa.repository.js';
export { PrismaMfaRepository } from './infrastructure/prisma-mfa.repository.js';

/** Adapt a TokenCipher (ADR-016 KMS / ADR-008 envelope) to the MFA port with the user+factor AAD (P-3). */
export function mfaCipherFrom(c: TokenCipher): MfaSecretCipher {
  return {
    encrypt: (p, x) => c.encryptUserSecret(p, { purpose: 'mfa.totp', ...x }),
    decrypt: (e, x) => c.decryptUserSecret(e, { purpose: 'mfa.totp', ...x }),
    keyIdOf: (e) => TokenCipher.keyIdOf(e) ?? 'unknown',
  };
}

/** Dev/test only: a random per-process key (secrets do not survive a restart). */
export const devMfaSecretCipher = (): MfaSecretCipher =>
  mfaCipherFrom(new TokenCipher(new LocalKeyProvider({ dev: randomBytes(32) }, 'dev')));

/**
 * Prisma when a database is configured; otherwise the in-memory store, whose enable/disable hook mirrors
 * users.mfa_enabled_at into the in-memory user repository.
 */
export function selectMfaRepository(deps: {
  mfa?: MfaRepository;
  db?: DatabaseClient;
  users: UserRepository;
}): MfaRepository {
  if (deps.mfa) return deps.mfa;
  if (deps.db) return new PrismaMfaRepository(deps.db);
  const users = deps.users as UserRepository & {
    setMfaEnabledAt?: (id: string, at: Date | null) => void;
  };
  return new InMemoryMfaRepository((id, at) => users.setMfaEnabledAt?.(id, at));
}
