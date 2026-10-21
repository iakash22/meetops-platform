import type { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { AuthService } from './auth/application/auth.service.js';
import { authRoutes } from './auth/http/auth.plugin.js';
import { randomBytes } from 'node:crypto';
import {
  assertProductionCookies,
  cookieConfig,
  DEV_WEB_ORIGINS,
  type HttpSecurityConfig
} from './auth/http/security.js';
import { Argon2PasswordHasher } from './auth/infrastructure/argon2-password-hasher.js';
import { CryptoTokenService, uuidGenerator } from './auth/infrastructure/crypto-token.service.js';
import { InMemorySessionRepository } from './auth/infrastructure/in-memory-session.repository.js';
import { InMemoryPasswordResetRepository } from './auth/infrastructure/in-memory-password-reset.repository.js';
import { InMemoryLoginLockout, InMemoryRateLimiter } from './auth/infrastructure/rate-limit/in-memory.js';
import type { SessionPolicy, SessionRepository } from './auth/domain/session.js';
import type { LoginLockout, PasswordHasher, RateLimiter, TokenService } from './auth/domain/ports.js';
import type { PasswordResetRepository } from './auth/domain/password-reset.js';
import { NoopAuthMailer, type AuthMailer } from './auth/domain/mailer.js';
import { InMemoryUserRepository } from './users/infrastructure/in-memory-user.repository.js';
import type { UserRepository } from './users/domain/user.repository.js';
import { OrganizationService } from './organizations/application/organization.service.js';
import { organizationRoutes } from './organizations/http/organizations.plugin.js';
import {
  InMemoryInvitationRepository,
  InMemoryMembershipRepository,
  InMemoryOrganizationRepository
} from './organizations/infrastructure/in-memory.repositories.js';
import type {
  InvitationRepository,
  MembershipRepository,
  OrganizationRepository
} from './organizations/domain/repositories.js';
import { systemClock, type Clock, type IdGenerator } from '../shared/ports.js';

export interface ModuleDeps {
  users: UserRepository;
  sessions: SessionRepository;
  passwordResets: PasswordResetRepository;
  organizations: OrganizationRepository;
  memberships: MembershipRepository;
  invitations: InvitationRepository;
  hasher: PasswordHasher;
  tokens: TokenService;
  rateLimiter: RateLimiter;
  lockout: LoginLockout;
  mailer: AuthMailer;
  clock: Clock;
  ids: IdGenerator;
  sessionPolicy: SessionPolicy;
  invitationTtlMs: number;
  passwordResetTtlMs: number;
  security: HttpSecurityConfig;
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Default deps. Repositories, rate limiter and lockout are in-memory until the Prisma
 * repositories and the Redis client wiring land (TODO(database), TODO(infra)).
 */
/**
 * In-memory implementations, a random CSRF secret and localhost origins are allowed ONLY when
 * NODE_ENV is exactly 'development' or 'test'. Any other value (including unset and 'staging')
 * fails closed and runs the full production checks.
 */
export function isRelaxedEnv(nodeEnv: string | undefined): boolean {
  return nodeEnv === 'development' || nodeEnv === 'test';
}

/** Implementations that must be injected (no in-memory fallback) outside development/test. */
export const PRODUCTION_REQUIRED_DEPS = [
  'users',
  'sessions',
  'passwordResets',
  'organizations',
  'memberships',
  'invitations',
  'rateLimiter',
  'lockout',
  'mailer'
] as const satisfies readonly (keyof ModuleDeps)[];

export class MissingProductionDependencyError extends Error {
  constructor(public readonly missing: string[]) {
    super(`Refusing to start in production without injected implementations for: ${missing.join(', ')}`);
    this.name = 'MissingProductionDependencyError';
  }
}

export function defaultModuleDeps(
  overrides: Partial<ModuleDeps> = {},
  env: { nodeEnv?: string | undefined } = { nodeEnv: process.env.NODE_ENV }
): ModuleDeps {
  const strict = !isRelaxedEnv(env.nodeEnv);
  if (strict) {
    const missing = PRODUCTION_REQUIRED_DEPS.filter((k) => overrides[k] === undefined);
    if (missing.length) throw new MissingProductionDependencyError(missing);
    if (!overrides.security) {
      const missingEnv = ['WEB_ORIGINS', 'CSRF_SECRET'].filter((k) => !process.env[k]);
      if (missingEnv.length) throw new MissingProductionDependencyError(missingEnv);
    }
  }
  const clock = overrides.clock ?? systemClock;
  const sessionPolicy = overrides.sessionPolicy ?? { idleTimeoutMs: 30 * MIN, absoluteTimeoutMs: 12 * HOUR };
  const allowedOrigins = (process.env.WEB_ORIGINS ?? (strict ? '' : DEV_WEB_ORIGINS.join(',')))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const security: HttpSecurityConfig = overrides.security ?? {
    ...cookieConfig(env.nodeEnv),
    allowedOrigins,
    sessionPolicy,
    // Dev/test: random per process. Production: required via CSRF_SECRET (checked above).
    csrfSecret: process.env.CSRF_SECRET
      ? Buffer.from(process.env.CSRF_SECRET, 'utf8')
      : strict
        ? Buffer.alloc(0)
        : randomBytes(32)
  };
  if (strict) assertProductionCookies(security);
  return {
    users: new InMemoryUserRepository(),
    sessions: new InMemorySessionRepository(),
    passwordResets: new InMemoryPasswordResetRepository(),
    organizations: new InMemoryOrganizationRepository(),
    memberships: new InMemoryMembershipRepository(),
    invitations: new InMemoryInvitationRepository(),
    hasher: new Argon2PasswordHasher(),
    tokens: new CryptoTokenService(),
    rateLimiter: new InMemoryRateLimiter(clock),
    lockout: new InMemoryLoginLockout(clock),
    mailer: new NoopAuthMailer(),
    ids: uuidGenerator,
    invitationTtlMs: 7 * DAY,
    passwordResetTtlMs: 30 * MIN,
    ...overrides,
    clock,
    sessionPolicy,
    security
  };
}

export async function registerModules(app: FastifyInstance, deps: ModuleDeps) {
  await app.register(cookie);
  const auth = new AuthService(deps);
  const organizations = new OrganizationService(deps);
  app.decorateRequest('auth', null);
  await app.register(authRoutes, { auth, organizations, security: deps.security });
  await app.register(organizationRoutes, { auth, organizations, mailer: deps.mailer, security: deps.security });
}
