import type { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { AuthService } from './auth/application/auth.service.js';
import { authRoutes } from './auth/http/auth.plugin.js';
import { cookieConfig, type HttpSecurityConfig } from './auth/http/security.js';
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
export function defaultModuleDeps(overrides: Partial<ModuleDeps> = {}): ModuleDeps {
  const clock = overrides.clock ?? systemClock;
  const sessionPolicy = overrides.sessionPolicy ?? { idleTimeoutMs: 30 * MIN, absoluteTimeoutMs: 12 * HOUR };
  const allowedOrigins = (process.env.WEB_ORIGINS ?? 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
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
    security: overrides.security ?? { ...cookieConfig(process.env.NODE_ENV), allowedOrigins, sessionPolicy }
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
