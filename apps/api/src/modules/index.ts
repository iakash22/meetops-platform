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
import { InMemoryOneTimeTokenRepository } from './auth/infrastructure/in-memory-one-time-token.repository.js';
import { InMemoryLoginLockout, InMemoryRateLimiter } from './auth/infrastructure/rate-limit/in-memory.js';
import type { SessionPolicy, SessionRepository } from './auth/domain/session.js';
import type { LoginLockout, PasswordHasher, RateLimiter, TokenService } from './auth/domain/ports.js';
import type { OneTimeTokenRepository } from './auth/domain/one-time-token.js';
import type { AuthMailQueue, MailTransport } from './auth/domain/mail-jobs.js';
import { InMemoryAuditLog, type AuditLog } from './auth/domain/audit.js';
import { AuthMailJobHandler, InlineAuthMailQueue } from './auth/application/auth-mail.handler.js';
import { SessionVerifier } from './auth/application/session-verifier.js';
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
  oneTimeTokens: OneTimeTokenRepository;
  organizations: OrganizationRepository;
  memberships: MembershipRepository;
  invitations: InvitationRepository;
  hasher: PasswordHasher;
  tokens: TokenService;
  rateLimiter: RateLimiter;
  lockout: LoginLockout;
  /** Production: inject a real queue (TODO(notifications #11)); dev/test: inline + transport below. */
  mailQueue: AuthMailQueue;
  /** Only used by the dev/test inline queue. */
  mailTransport: MailTransport;
  audit: AuditLog;
  webBaseUrl: string;
  clock: Clock;
  ids: IdGenerator;
  sessionPolicy: SessionPolicy;
  invitationTtlMs: number;
  passwordResetTtlMs: number;
  emailVerificationTtlMs: number;
  /** Optional progressive-delay sleeper for failed logins (tests inject a fake). */
  sleep?: (ms: number) => Promise<void>;
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
  'oneTimeTokens',
  'organizations',
  'memberships',
  'invitations',
  'rateLimiter',
  'lockout',
  'mailQueue',
  'audit'
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
  const memberships = overrides.memberships ?? new InMemoryMembershipRepository();
  return {
    users: new InMemoryUserRepository(),
    sessions: new InMemorySessionRepository(),
    oneTimeTokens: new InMemoryOneTimeTokenRepository(),
    organizations: new InMemoryOrganizationRepository(),
    memberships,
    invitations: new InMemoryInvitationRepository(
      memberships instanceof InMemoryMembershipRepository ? memberships : undefined
    ),
    hasher: new Argon2PasswordHasher(),
    tokens: new CryptoTokenService(),
    rateLimiter: new InMemoryRateLimiter(clock),
    lockout: new InMemoryLoginLockout(clock),
    mailQueue: new InlineAuthMailQueue(),
    // `mailer` is a legacy alias used only by the repo-level QA harness (tests/support).
    mailTransport: (overrides as { mailer?: MailTransport }).mailer ?? { send: async () => {} },
    audit: new InMemoryAuditLog(),
    webBaseUrl: process.env.WEB_BASE_URL ?? 'http://localhost:5173',
    ids: uuidGenerator,
    invitationTtlMs: 7 * DAY,
    passwordResetTtlMs: 30 * MIN,
    emailVerificationTtlMs: DAY,
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
  if (deps.mailQueue instanceof InlineAuthMailQueue && !deps.mailQueue.handler) {
    deps.mailQueue.handler = new AuthMailJobHandler({ ...deps, transport: deps.mailTransport });
  }
  app.decorateRequest('auth', null);
  await app.register(authRoutes, { auth, organizations, security: deps.security });
  await app.register(organizationRoutes, { auth, organizations, security: deps.security });
  return { auth, organizations, sessionVerifier: new SessionVerifier(auth, deps.memberships) };
}
