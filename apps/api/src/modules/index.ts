import type { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { EXTENSION_AUTH_PATHS } from '@meetops/contracts';
import {
  extensionBearerCorsHook,
  isExtensionBearerPath,
  isExtensionOrigin,
} from './extension-auth/http/bearer-cors.js';
import { AuthService } from './auth/application/auth.service.js';
import { authRoutes } from './auth/http/auth.plugin.js';
import { randomBytes } from 'node:crypto';
import {
  assertProductionCookies,
  cookieConfig,
  DEV_WEB_ORIGINS,
  type HttpSecurityConfig,
} from './auth/http/security.js';
import { Argon2PasswordHasher } from './auth/infrastructure/argon2-password-hasher.js';
import { CryptoTokenService, uuidGenerator } from './auth/infrastructure/crypto-token.service.js';
import { InMemorySessionRepository } from './auth/infrastructure/in-memory-session.repository.js';
import { InMemoryOneTimeTokenRepository } from './auth/infrastructure/in-memory-one-time-token.repository.js';
import {
  InMemoryLoginLockout,
  InMemoryRateLimiter,
} from './auth/infrastructure/rate-limit/in-memory.js';
import {
  RedisLoginLockout,
  RedisRateLimiter,
  type RedisLike,
} from './auth/infrastructure/rate-limit/redis.js';
import { PrismaAuditLog } from './auth/infrastructure/prisma/prisma-audit.log.js';
import { PrismaOneTimeTokenRepository } from './auth/infrastructure/prisma/prisma-one-time-token.repository.js';
import { PrismaSessionRepository } from './auth/infrastructure/prisma/prisma-session.repository.js';
import { PrismaUserRepository } from './users/infrastructure/prisma/prisma-user.repository.js';
import {
  PrismaInvitationRepository,
  PrismaMembershipRepository,
  PrismaOrganizationRepository,
} from './organizations/infrastructure/prisma/prisma.repositories.js';
import { createPrismaClient, type DatabaseClient } from '../shared/prisma/context.js';
import { Redis } from 'ioredis';
import type { SessionPolicy, SessionRepository } from './auth/domain/session.js';
import type {
  LoginLockout,
  PasswordHasher,
  RateLimiter,
  TokenService,
} from './auth/domain/ports.js';
import type { OneTimeTokenRepository } from './auth/domain/one-time-token.js';
import type { AuthMailQueue, MailTransport } from './auth/domain/mail-jobs.js';
import { InMemoryAuditLog, type AuditLog } from './auth/domain/audit.js';
import { AuthMailJobHandler, InlineAuthMailQueue } from './auth/application/auth-mail.handler.js';
import { SessionVerifier } from './auth/application/session-verifier.js';
import {
  noopRevocationPublisher,
  type RevocationPublisher,
} from './auth/application/revocations.js';
import { createRedisRevocationPublisher } from '@meetops/session-verifier';
import {
  ExtensionAuthService,
  extensionAuthRoutes,
  InMemoryExtensionTokenRepository,
  RedisExtensionTokenRepository,
  DurableExtensionTokenRepository,
  makeExtensionBearerGuard,
  type ExtensionTokenRepository,
} from './extension-auth/index.js';
import { InMemoryUserRepository } from './users/infrastructure/in-memory-user.repository.js';
import type { UserRepository } from './users/domain/user.repository.js';
import { OrganizationService } from './organizations/application/organization.service.js';
import { organizationRoutes } from './organizations/http/organizations.plugin.js';
import {
  InMemoryInvitationRepository,
  InMemoryMembershipRepository,
  InMemoryOrganizationRepository,
} from './organizations/infrastructure/in-memory.repositories.js';
import type {
  InvitationRepository,
  MembershipRepository,
  OrganizationRepository,
} from './organizations/domain/repositories.js';
import type { MeetingRepository } from './meetings/domain/meeting.js';
import { InMemoryMeetingRepository } from './meetings/infrastructure/in-memory.repository.js';
import { PrismaMeetingRepository } from './meetings/infrastructure/prisma.repository.js';
import type { ConsentRepository } from './media/domain/consent.js';
import type { FileObjectRepository, MediaJobQueue, MediaSigner } from './media/domain/ports.js';
import type { RecordingSessionRepository } from './media/domain/recording-session.js';
import {
  FakeMediaSigner,
  InMemoryConsentRepository,
  InMemoryFileObjectRepository,
  InMemoryMediaJobQueue,
  InMemoryRecordingSessionRepository,
} from './media/infrastructure/in-memory.js';
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
  /**
   * Shared Redis client. When set (or REDIS_URL is set outside NODE_ENV=test), the rate limiter
   * and login lockout default to RedisRateLimiter / RedisLoginLockout. Only clients created here
   * from REDIS_URL are closed on shutdown.
   */
  redis?: RedisLike;
  /** Set when defaultModuleDeps created the client itself (closed in an onClose hook). */
  ownedRedis?: OwnedRedis;
  /**
   * Prisma client. When set (or DATABASE_URL is set outside NODE_ENV=test), users, sessions,
   * one-time tokens, organizations, memberships, invitations and the audit log default to the
   * Prisma implementations. Only clients created here from DATABASE_URL are closed on shutdown.
   */
  db?: DatabaseClient;
  /** Set when defaultModuleDeps created the Prisma client itself (disconnected in an onClose hook). */
  ownedDb?: { $disconnect(): Promise<void> };
  /**
   * ADR-011 revocation fan-out (meetops:auth:revocations). Defaults to publishing on `redis` when
   * the client supports PUBLISH, otherwise a no-op.
   */
  revocations?: RevocationPublisher;
  /** Meetings repository (Prisma when `db` is set; in-memory only in development/test). */
  meetings: MeetingRepository;
  /** ADR-005 extension pairing/token store (Redis when `redis` is set; in-memory only in development/test). */
  extensionTokens: ExtensionTokenRepository;
  /** ADR-005 allowlisted Chrome extension ids (EXTENSION_IDS; plus EXTENSION_DEV_IDS in development/test). */
  extensionIds: readonly string[];
  /**
   * Media (uploads / recording sessions) adapters. Defaults to in-memory ONLY in development/test; outside them it
   * stays unset unless injected and the media routes are not registered (no production adapters yet).
   */
  media?: MediaAdapters;
}

/** Ports the media module needs. */
export interface MediaAdapters {
  files: FileObjectRepository;
  consents: ConsentRepository;
  signer: MediaSigner;
  jobs: MediaJobQueue;
  sessions: RecordingSessionRepository;
}

export function inMemoryMediaAdapters(clock: Clock = systemClock): MediaAdapters {
  return {
    files: new InMemoryFileObjectRepository(),
    consents: new InMemoryConsentRepository(),
    signer: new FakeMediaSigner(() => clock.now()),
    jobs: new InMemoryMediaJobQueue(),
    sessions: new InMemoryRecordingSessionRepository(),
  };
}

/** Revocation publisher over the shared Redis client, or a no-op without one. */
export function defaultRevocationPublisher(
  redis: RedisLike | undefined,
  clock: Clock,
): RevocationPublisher {
  const publish = redis?.publish?.bind(redis);
  return publish ? createRedisRevocationPublisher({ publish }, clock) : noopRevocationPublisher;
}

/** Owned Redis client; `status`/`disconnect` let shutdown skip QUIT on a never-connected lazy client. */
export type OwnedRedis = Pick<Redis, 'quit' | 'disconnect' | 'status'>;

/** What defaultModuleDeps reads from the environment. An explicit object replaces process.env. */
export interface ModuleEnv {
  nodeEnv?: string | undefined;
  redisUrl?: string | undefined;
  databaseUrl?: string | undefined;
}

export const moduleEnvFromProcess = (): ModuleEnv => ({
  nodeEnv: process.env.NODE_ENV,
  redisUrl: process.env.REDIS_URL,
  databaseUrl: process.env.DATABASE_URL,
});

/** Deps the Prisma client provides when no implementation is injected. */
export const DATABASE_BACKED_DEPS = [
  'users',
  'sessions',
  'oneTimeTokens',
  'organizations',
  'memberships',
  'invitations',
  'meetings',
  'audit',
] as const satisfies readonly (keyof ModuleDeps)[];

/** Deps the Redis client provides when no implementation is injected. */
export const REDIS_BACKED_DEPS = [
  'rateLimiter',
  'lockout',
  'revocations',
  'extensionTokens',
] as const satisfies readonly (keyof ModuleDeps)[];

/** Connection URLs are ignored under NODE_ENV=test: tests stay hermetic unless they inject a client. */
const urlFor = (env: ModuleEnv, url: string | undefined) =>
  env.nodeEnv !== 'test' && url ? url : undefined;

const allInjected = (overrides: Partial<ModuleDeps>, keys: readonly (keyof ModuleDeps)[]) =>
  keys.every((k) => overrides[k] !== undefined);

/**
 * Picks the Redis client: an injected `redis` dep wins, otherwise REDIS_URL. No client is created
 * when every Redis-backed dep is injected.
 */
function resolveRedis(
  overrides: Partial<ModuleDeps>,
  env: ModuleEnv,
): { redis?: RedisLike; owned?: Redis } {
  if (overrides.redis) return { redis: overrides.redis };
  const url = urlFor(env, env.redisUrl);
  if (!url || allInjected(overrides, REDIS_BACKED_DEPS)) return {};
  const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 });
  return { redis: client, owned: client };
}

/**
 * Picks the Prisma client: an injected `db` dep wins, otherwise DATABASE_URL. No client is created
 * when every database-backed dep is injected. Prisma connects lazily on the first query.
 */
function resolveDatabase(
  overrides: Partial<ModuleDeps>,
  env: ModuleEnv,
): { db?: DatabaseClient; owned?: DatabaseClient } {
  if (overrides.db) return { db: overrides.db };
  const databaseUrl = urlFor(env, env.databaseUrl);
  if (!databaseUrl || allInjected(overrides, DATABASE_BACKED_DEPS)) return {};
  const client = createPrismaClient({ databaseUrl });
  return { db: client, owned: client };
}

/** QUIT a connected client; a lazy client that never connected is just dropped. */
export async function closeOwnedRedis(client: OwnedRedis): Promise<void> {
  if (client.status === 'wait' || client.status === 'end') {
    client.disconnect();
    return;
  }
  await client.quit().catch(() => client.disconnect());
}

const csv = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

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
  'meetings',
  'rateLimiter',
  'lockout',
  'mailQueue',
  // The default transport drops every mail (no-op); production must inject a real one, e.g.
  // createAuthMailTransport(createEmailService(loadEmailConfig())) from @meetops/notifications.
  'mailTransport',
  'audit',
  'extensionTokens',
] as const satisfies readonly (keyof ModuleDeps)[];

export class MissingProductionDependencyError extends Error {
  constructor(public readonly missing: string[]) {
    super(
      `Refusing to start in production without injected implementations for: ${missing.join(', ')}`,
    );
    this.name = 'MissingProductionDependencyError';
  }
}

/**
 * Default deps. With a Prisma client (injected `db`, or DATABASE_URL outside NODE_ENV=test) the
 * repositories and audit log are the Prisma ones; with Redis (injected `redis`, or REDIS_URL outside
 * NODE_ENV=test) the rate limiter and lockout are Redis-backed. Anything else falls back to
 * in-memory, which only development/test accept. Injected overrides always win.
 */
export function defaultModuleDeps(
  overrides: Partial<ModuleDeps> = {},
  env: ModuleEnv = moduleEnvFromProcess(),
): ModuleDeps {
  const strict = !isRelaxedEnv(env.nodeEnv);
  // Database/Redis-backed deps are satisfied by an injected client or its URL; without either,
  // strict environments still fail closed via PRODUCTION_REQUIRED_DEPS. Checked before any client
  // is created, so a refused start leaks no connections.
  const hasDb = !!overrides.db || !!urlFor(env, env.databaseUrl);
  const hasRedis = !!overrides.redis || !!urlFor(env, env.redisUrl);
  const provided = (k: keyof ModuleDeps) =>
    ((DATABASE_BACKED_DEPS as readonly string[]).includes(k) && hasDb) ||
    ((REDIS_BACKED_DEPS as readonly string[]).includes(k) && hasRedis) ||
    (k === 'mailTransport' && (overrides as { mailer?: unknown }).mailer !== undefined);
  if (strict) {
    const missing = PRODUCTION_REQUIRED_DEPS.filter(
      (k) => overrides[k] === undefined && !provided(k),
    );
    if (missing.length) throw new MissingProductionDependencyError(missing);
    if (!overrides.security) {
      const missingEnv = ['WEB_ORIGINS', 'CSRF_SECRET'].filter((k) => !process.env[k]);
      if (missingEnv.length) throw new MissingProductionDependencyError(missingEnv);
    }
  }
  const clock = overrides.clock ?? systemClock;
  const sessionPolicy = overrides.sessionPolicy ?? {
    idleTimeoutMs: 30 * MIN,
    absoluteTimeoutMs: 12 * HOUR,
  };
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
        : randomBytes(32),
  };
  if (strict) assertProductionCookies(security);
  const { redis, owned: ownedRedis } = resolveRedis(overrides, env);
  const { db, owned: ownedDb } = resolveDatabase(overrides, env);
  // Dev/test fallback only below: strict envs reach here with a client or an injected dep for
  // every PRODUCTION_REQUIRED_DEPS entry (checked above).
  const memberships =
    overrides.memberships ??
    (db ? new PrismaMembershipRepository(db) : new InMemoryMembershipRepository());
  const persistence = db
    ? {
        users: new PrismaUserRepository(db),
        sessions: new PrismaSessionRepository(db, sessionPolicy.idleTimeoutMs),
        oneTimeTokens: new PrismaOneTimeTokenRepository(db),
        organizations: new PrismaOrganizationRepository(db),
        invitations: new PrismaInvitationRepository(db),
        meetings: new PrismaMeetingRepository(db),
        audit: new PrismaAuditLog(db),
      }
    : {
        users: new InMemoryUserRepository(),
        sessions: new InMemorySessionRepository(),
        oneTimeTokens: new InMemoryOneTimeTokenRepository(),
        organizations: new InMemoryOrganizationRepository(),
        invitations: new InMemoryInvitationRepository(
          memberships instanceof InMemoryMembershipRepository ? memberships : undefined,
        ),
        meetings: new InMemoryMeetingRepository(() => clock.now()),
        audit: new InMemoryAuditLog(),
      };
  return {
    ...persistence,
    memberships,
    hasher: new Argon2PasswordHasher(),
    tokens: new CryptoTokenService(),
    rateLimiter: redis ? new RedisRateLimiter(redis) : new InMemoryRateLimiter(clock),
    lockout: redis ? new RedisLoginLockout(redis) : new InMemoryLoginLockout(clock),
    mailQueue: new InlineAuthMailQueue(),
    // ADR-005 A1.2: Redis fast path, Postgres durable authority when both are configured.
    extensionTokens: redis
      ? db
        ? new DurableExtensionTokenRepository(new RedisExtensionTokenRepository(redis), db)
        : new RedisExtensionTokenRepository(redis)
      : new InMemoryExtensionTokenRepository(),
    extensionIds: [
      ...csv(process.env.EXTENSION_IDS),
      ...(strict ? [] : csv(process.env.EXTENSION_DEV_IDS)),
    ],
    // `mailer` is a legacy alias used only by the repo-level QA harness (tests/support).
    mailTransport: (overrides as { mailer?: MailTransport }).mailer ?? { send: async () => {} },
    webBaseUrl: process.env.WEB_BASE_URL ?? 'http://localhost:5173',
    ids: uuidGenerator,
    invitationTtlMs: 7 * DAY,
    passwordResetTtlMs: 30 * MIN,
    emailVerificationTtlMs: DAY,
    ...(strict ? {} : { media: inMemoryMediaAdapters(clock) }),
    ...overrides,
    ...(redis ? { redis } : {}),
    ...(ownedRedis ? { ownedRedis } : {}),
    ...(db ? { db } : {}),
    ...(ownedDb ? { ownedDb } : {}),
    revocations: overrides.revocations ?? defaultRevocationPublisher(redis, clock),
    clock,
    sessionPolicy,
    security,
  };
}

export async function registerModules(app: FastifyInstance, deps: ModuleDeps) {
  await app.register(cookie);
  // Web CORS: credentialed, exact-match allowlist from WEB_ORIGINS (same list as the Origin check).
  // No wildcard, no reflection of unknown origins. Extension lifecycle routes keep their own
  // credential-less CORS (ADR-005 A1.3.6), so they are skipped here.
  const webOrigins = new Set(deps.security.allowedOrigins);
  const extensionPaths = new Set<string>([
    EXTENSION_AUTH_PATHS.token,
    EXTENSION_AUTH_PATHS.refresh,
    EXTENSION_AUTH_PATHS.revoke,
  ]);
  await app.register(cors, {
    hook: 'onRequest',
    delegator: (request, cb) => {
      const path = (request.url ?? '').split('?')[0] ?? '';
      const origin = request.headers.origin;
      // Extension-origin calls to bearer routes get the credential-less CORS below, never this one.
      const extensionBearer = isExtensionOrigin(origin) && isExtensionBearerPath(path);
      const allowed =
        !extensionPaths.has(path) &&
        !extensionBearer &&
        typeof origin === 'string' &&
        webOrigins.has(origin);
      cb(null, {
        origin: allowed ? origin : false,
        credentials: true,
        methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
        allowedHeaders: ['content-type', 'x-csrf-token'],
        maxAge: 600,
        strictPreflight: true,
      });
    },
  });
  // ADR-005 A1.3.6: credential-less CORS for allowlisted extension origins on the bearer-enabled routes.
  app.addHook(
    'onRequest',
    extensionBearerCorsHook(deps.extensionIds.map((id) => `chrome-extension://${id}`)),
  );
  // Close only the clients defaultModuleDeps created; injected ones belong to the caller.
  const { ownedRedis, ownedDb } = deps;
  if (ownedRedis || ownedDb) {
    app.addHook('onClose', async () => {
      await Promise.allSettled([
        ownedRedis ? closeOwnedRedis(ownedRedis) : undefined,
        ownedDb ? ownedDb.$disconnect() : undefined,
      ]);
    });
  }
  const extensionAuth = new ExtensionAuthService(deps);
  // ADR-005 A1.6: logout, password reset and member removal also revoke extension token families.
  const auth = new AuthService({ ...deps, extensionRevoker: extensionAuth });
  const organizations = new OrganizationService({ ...deps, extensionRevoker: extensionAuth });
  if (deps.mailQueue instanceof InlineAuthMailQueue && !deps.mailQueue.handler) {
    deps.mailQueue.handler = new AuthMailJobHandler({ ...deps, transport: deps.mailTransport });
  }
  app.decorateRequest('auth', null);
  const sessionVerifier = new SessionVerifier({
    ...deps,
    extensionTokenStore: extensionAuth.verifierStore(),
  });
  // ADR-005 A1.3.1: meetings/resolve and recording/upload routes also accept the extension bearer token.
  const extensionBearer = makeExtensionBearerGuard(sessionVerifier, deps.security.cookieName);
  await app.register(authRoutes, { auth, organizations, security: deps.security });
  await app.register(organizationRoutes, { auth, organizations, security: deps.security });
  await app.register(extensionAuthRoutes, { auth, extensionAuth, security: deps.security });
  await app.register(import('./directory/index.js'), { auth, organizations, deps });
  await app.register(import('./tasks/index.js'), { auth, organizations, deps });
  await app.register(import('./meeting-insights/index.js'), { auth, organizations, deps });
  await app.register(import('./integrations/index.js'), { auth, organizations, deps });
  await app.register(import('./meetings/index.js'), {
    auth,
    organizations,
    deps,
    extensionBearer,
  });
  await app.register(import('./media/index.js'), {
    auth,
    organizations,
    deps,
    extensionBearer,
    sessionVerifier,
  });
  return {
    auth,
    organizations,
    sessionVerifier,
    extensionAuth,
  };
}
