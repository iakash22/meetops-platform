import { createGeoIpProvider, type GeoIpProvider } from '../shared/geoip/index.js';
import type { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { DESKTOP_AUTH_PATHS, EXTENSION_AUTH_PATHS } from '@meetops/contracts';
import {
  extensionBearerCorsHook,
  isExtensionBearerPath,
  isExtensionOrigin,
} from './extension-auth/http/bearer-cors.js';
import {
  ConsoleEmailService,
  createAuthMailTransport,
  createEmailService,
  loadEmailConfig,
  type EmailConfig,
  type EmailService,
} from '@meetops/notifications';
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
import {
  BullMqAuthMailQueue,
  createAuthMailProducer,
  startAuthMailWorker,
  type AuthMailProducer,
} from './auth/infrastructure/mail-queue/bullmq-mail-queue.js';
import { loadAuthMailQueueEnv } from './auth/infrastructure/mail-queue/env.js';
import { SessionVerifier } from './auth/application/session-verifier.js';
import {
  noopRevocationPublisher,
  type RevocationPublisher,
} from './auth/application/revocations.js';
import { createRedisRevocationPublisher } from '@meetops/session-verifier';
import {
  ExtensionAuthService,
  type ExtensionAuthLog,
  extensionAuthRoutes,
  InMemoryExtensionTokenRepository,
  RedisExtensionTokenRepository,
  DurableExtensionTokenRepository,
  makeExtensionBearerGuard,
  type ExtensionTokenRepository,
} from './extension-auth/index.js';
import {
  combineBearerStores,
  combineRevokers,
  DesktopAuthService,
  desktopAuthRoutes,
} from './desktop-auth/index.js';
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
import {
  PrismaConsentRepository,
  PrismaFileObjectRepository,
  PrismaRecordingSessionRepository,
} from './media/infrastructure/prisma.js';
import { BullMqMediaJobQueue, createMediaQueueProducer } from './media/infrastructure/bullmq.js';
import { loadStorageConfig, S3UploadSourceSigner } from '@meetops/storage';
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
  /**
   * AUTH_MAIL_QUEUE=bullmq: BullMqAuthMailQueue on REDIS_URL (ADR-013, notifications #11), consumed by the
   * auth-mail worker (authMailWorker). Otherwise (dev/test default) the inline queue + transport below.
   */
  mailQueue: AuthMailQueue;
  /** Used by the inline queue and by the auth-mail worker consumer (the EMAIL_PROVIDER-selected EmailService). */
  mailTransport: MailTransport;
  /** When set with a BullMqAuthMailQueue, registerModules starts the auth-mail BullMQ consumer in-process. */
  authMailWorker?: { redisUrl: string; prefix?: string | undefined; concurrency: number };
  /** Set when defaultModuleDeps created the BullMQ mail queue itself (closed in onClose). */
  ownedMailQueue?: { close(): Promise<void> };
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
  /** ADR-014 local GeoIP provider (GEOIP_PROVIDER / GEOIP_DB_PATH; null provider when unset). */
  geoIp?: GeoIpProvider;
  /** Meetings repository (Prisma when `db` is set; in-memory only in development/test). */
  meetings: MeetingRepository;
  /** ADR-005 extension pairing/token store (Redis when `redis` is set; in-memory only in development/test). */
  extensionTokens: ExtensionTokenRepository;
  /** ADR-005 allowlisted Chrome extension ids (EXTENSION_IDS; plus EXTENSION_DEV_IDS in development/test). */
  extensionIds: readonly string[];
  /** ADR-005 A1.4 security-signal logger for extension auth; defaults to the app's (redacting) logger. */
  extensionAuthLog?: ExtensionAuthLog;
  /**
   * ADR-012 desktop sign-in. Off unless DESKTOP_AUTH_ENABLED=true (the ADR-012 amendment, PR #192, awaits sign-off).
   * When off, the /auth/desktop/* routes are not registered and desktop bearers never verify.
   */
  desktopAuthEnabled?: boolean;
  /** Desktop token store: its own Redis prefix (meetops:desktop:) when `redis` is set; in-memory otherwise. */
  desktopTokens?: ExtensionTokenRepository;
  /**
   * Media (uploads / recording sessions) adapters. With MEDIA_STORAGE_ENABLED=true and a database, uploads use
   * S3/MinIO (@meetops/storage) plus the Prisma file_objects / consent_attestations tables. Otherwise in-memory ONLY
   * in development/test; outside them it stays unset unless injected and the media routes are not registered.
   */
  media?: MediaAdapters;
  /** Set when defaultModuleDeps built the storage-backed media adapters (BullMQ producer closed in onClose). */
  ownedMedia?: { close(): Promise<void> };
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

/** MEDIA_STORAGE_ENABLED: real storage for the media routes (off by default). */
export function mediaStorageEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const v = (env.MEDIA_STORAGE_ENABLED ?? '').trim().toLowerCase();
  if (v === '' || ['false', '0', 'no', 'off'].includes(v)) return false;
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  throw new Error('MEDIA_STORAGE_ENABLED must be a boolean');
}

/**
 * Storage-backed media adapters: S3/MinIO signer (STORAGE_* env), Prisma file / consent / recording-session tables
 * and a BullMQ producer on the worker's MEDIA_QUEUE (REDIS_URL). `close` shuts the producer it created.
 */
export function storageMediaAdapters(
  db: DatabaseClient,
  env: Record<string, string | undefined> = {},
  clock: Clock = systemClock,
  opts: { signer?: MediaSigner; jobs?: MediaJobQueue } = {},
): MediaAdapters & { close(): Promise<void> } {
  const config = loadStorageConfig(env);
  let owned: BullMqMediaJobQueue | undefined;
  let jobs = opts.jobs;
  if (!jobs) {
    if (!env.REDIS_URL)
      throw new Error('MEDIA_STORAGE_ENABLED=true requires REDIS_URL (media job queue)');
    jobs = owned = new BullMqMediaJobQueue(createMediaQueueProducer(env.REDIS_URL));
  }
  return {
    files: new PrismaFileObjectRepository(db, config.bucket, config.provider),
    consents: new PrismaConsentRepository(db),
    signer: opts.signer ?? new S3UploadSourceSigner({ config, now: () => clock.now() }),
    jobs,
    sessions: new PrismaRecordingSessionRepository(db, config.bucket, config.provider),
    close: async () => {
      await owned?.close();
    },
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
  /**
   * Email provider variables (EMAIL_PROVIDER, SMTP_*, RESEND_API_KEY, EMAIL_FROM). Omitted means
   * unconfigured: dev/test fall back to the in-memory console sender, strict envs refuse to start.
   */
  emailEnv?: Record<string, string | undefined> | undefined;
  /** MEDIA_STORAGE_ENABLED and STORAGE_* (#300 L-2). Omitted means unset: the flag is off. */
  storageEnv?: Record<string, string | undefined> | undefined;
  /** AUTH_MAIL_QUEUE, AUTH_MAIL_QUEUE_PREFIX, AUTH_MAIL_WORKER_ENABLED, AUTH_MAIL_WORKER_CONCURRENCY. */
  mailQueueEnv?: Record<string, string | undefined> | undefined;
  /** Test seam: BullMQ producer used instead of one on REDIS_URL when AUTH_MAIL_QUEUE=bullmq. */
  mailQueueProducer?: AuthMailProducer | undefined;
  /** Test seam: fake SMTP transport factory / fetch for the selected EmailService (no network in tests). */
  emailServiceDeps?: EmailServiceDeps | undefined;
}

type EmailServiceDeps = Pick<
  NonNullable<Parameters<typeof createEmailService>[1]>,
  'fetch' | 'smtpTransportFactory'
>;

export const moduleEnvFromProcess = (): ModuleEnv => ({
  nodeEnv: process.env.NODE_ENV,
  redisUrl: process.env.REDIS_URL,
  databaseUrl: process.env.DATABASE_URL,
  emailEnv: process.env,
  storageEnv: process.env,
  mailQueueEnv: process.env,
});

const EMAIL_ENV_KEYS = ['EMAIL_PROVIDER', 'SMTP_HOST', 'RESEND_API_KEY'] as const;

/** True when any provider-selecting email variable is set (empty strings count as unset). */
export const emailConfigured = (emailEnv: ModuleEnv['emailEnv']) =>
  !!emailEnv && EMAIL_ENV_KEYS.some((k) => !!emailEnv[k]?.trim());

/**
 * Email config from the environment, or null when unconfigured. Configured-but-invalid throws
 * EmailConfigError (names the bad variables, never their values) in every environment. Under
 * NODE_ENV=test the env is ignored so tests never reach a real provider.
 */
function resolveEmailConfig(env: ModuleEnv): EmailConfig | null {
  // emailServiceDeps (fakes only) lets tests exercise a configured provider without any network.
  if ((env.nodeEnv === 'test' && !env.emailServiceDeps) || !emailConfigured(env.emailEnv))
    return null;
  return loadEmailConfig(env.emailEnv);
}

/** Dev/test sender: keeps nothing (bodies hold one-time links) and logs nothing. */
function devConsoleEmailService(): EmailService {
  const inner = new ConsoleEmailService();
  return {
    provider: inner.provider,
    async send(message) {
      const result = await inner.send(message);
      inner.clear();
      return result;
    },
    verify: () => inner.verify(),
  };
}

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
  // Satisfied by an injected transport or by EMAIL_PROVIDER/SMTP_*/RESEND_API_KEY (+ EMAIL_FROM).
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
  // Configured-but-invalid email settings throw EmailConfigError here, before any client is made.
  const injectedMail = overrides.mailTransport ?? (overrides as { mailer?: MailTransport }).mailer;
  const emailConfig = injectedMail ? null : resolveEmailConfig(env);
  const hasDb = !!overrides.db || !!urlFor(env, env.databaseUrl);
  const hasRedis = !!overrides.redis || !!urlFor(env, env.redisUrl);
  const mailQueueCfg = loadAuthMailQueueEnv(env.mailQueueEnv);
  const useBullMail = !overrides.mailQueue && mailQueueCfg.mode === 'bullmq';
  const mailRedisUrl = useBullMail ? urlFor(env, env.redisUrl) : undefined;
  if (useBullMail) {
    if (!mailRedisUrl && !env.mailQueueProducer)
      throw new Error('AUTH_MAIL_QUEUE=bullmq requires REDIS_URL');
    // The worker sends through the one EmailService EMAIL_PROVIDER selects (smtp or resend); never a fallback.
  }
  const provided = (k: keyof ModuleDeps) =>
    ((DATABASE_BACKED_DEPS as readonly string[]).includes(k) && hasDb) ||
    ((REDIS_BACKED_DEPS as readonly string[]).includes(k) && hasRedis) ||
    (k === 'mailQueue' && useBullMail) ||
    (k === 'mailTransport' &&
      ((overrides as { mailer?: unknown }).mailer !== undefined || emailConfig !== null));
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
  const useStorageMedia = !overrides.media && mediaStorageEnabled(env.storageEnv ?? {});
  if (useStorageMedia && !db) throw new Error('MEDIA_STORAGE_ENABLED=true requires DATABASE_URL');
  const storageMedia =
    useStorageMedia && db ? storageMediaAdapters(db, env.storageEnv ?? {}, clock) : undefined;
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
  const deps: ModuleDeps = {
    ...persistence,
    memberships,
    hasher: new Argon2PasswordHasher(),
    tokens: new CryptoTokenService(),
    rateLimiter: redis ? new RedisRateLimiter(redis) : new InMemoryRateLimiter(clock),
    lockout: redis ? new RedisLoginLockout(redis) : new InMemoryLoginLockout(clock),
    mailQueue: new InlineAuthMailQueue(),
    ...(useBullMail
      ? (() => {
          const q = new BullMqAuthMailQueue(
            env.mailQueueProducer ??
              createAuthMailProducer({ redisUrl: mailRedisUrl!, prefix: mailQueueCfg.prefix }),
            clock,
          );
          return {
            mailQueue: q,
            ownedMailQueue: q,
            ...(mailQueueCfg.workerEnabled && mailRedisUrl
              ? {
                  authMailWorker: {
                    redisUrl: mailRedisUrl,
                    prefix: mailQueueCfg.prefix,
                    concurrency: mailQueueCfg.concurrency,
                  },
                }
              : {}),
          };
        })()
      : {}),
    // ADR-005 A1.2: Redis fast path, Postgres durable authority when both are configured.
    extensionTokens: redis
      ? db
        ? new DurableExtensionTokenRepository(new RedisExtensionTokenRepository(redis), db)
        : new RedisExtensionTokenRepository(redis)
      : new InMemoryExtensionTokenRepository(),
    desktopAuthEnabled: process.env.DESKTOP_AUTH_ENABLED === 'true',
    desktopTokens: redis
      ? new RedisExtensionTokenRepository(redis, 'meetops:desktop:')
      : new InMemoryExtensionTokenRepository(),
    extensionIds: [
      ...csv(process.env.EXTENSION_IDS),
      ...(strict ? [] : csv(process.env.EXTENSION_DEV_IDS)),
    ],
    // `mailer` is a legacy alias used only by the repo-level QA harness (tests/support).
    // Placeholder replaced below once the TTLs (which the templates display) are final.
    mailTransport: injectedMail ?? { send: async () => {} },
    webBaseUrl: process.env.WEB_BASE_URL ?? 'http://localhost:5173',
    ids: uuidGenerator,
    invitationTtlMs: 7 * DAY,
    passwordResetTtlMs: 30 * MIN,
    emailVerificationTtlMs: DAY,
    ...(storageMedia
      ? { media: storageMedia, ownedMedia: storageMedia }
      : strict
        ? {}
        : { media: inMemoryMediaAdapters(clock) }),
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
  if (!injectedMail) {
    // Strict envs only get here with a valid emailConfig (PRODUCTION_REQUIRED_DEPS check above).
    const service = emailConfig
      ? createEmailService(emailConfig, { ...env.emailServiceDeps, nodeEnv: env.nodeEnv })
      : devConsoleEmailService();
    deps.mailTransport = createAuthMailTransport(service, {
      verificationExpiresInHours: Math.max(1, Math.round(deps.emailVerificationTtlMs / HOUR)),
      passwordResetExpiresInMinutes: Math.max(1, Math.round(deps.passwordResetTtlMs / MIN)),
    });
  }
  return deps;
}

export async function registerModules(app: FastifyInstance, deps: ModuleDeps) {
  await app.register(cookie);
  // Web CORS: credentialed, exact-match allowlist from WEB_ORIGINS (same list as the Origin check).
  // No wildcard, no reflection of unknown origins. Extension lifecycle routes keep their own
  // credential-less CORS (ADR-005 A1.3.6), so they are skipped here.
  const webOrigins = new Set(deps.security.allowedOrigins);
  // Desktop (ADR-012) app routes are called by the native app, never by a browser page: no CORS at all, not even for
  // the web origins (security review B 2.2). Only `authorize` (a web-session route) keeps web CORS.
  const extensionPaths = new Set<string>([
    EXTENSION_AUTH_PATHS.token,
    EXTENSION_AUTH_PATHS.refresh,
    EXTENSION_AUTH_PATHS.revoke,
    DESKTOP_AUTH_PATHS.token,
    DESKTOP_AUTH_PATHS.refresh,
    DESKTOP_AUTH_PATHS.revoke,
    DESKTOP_AUTH_PATHS.switchOrg,
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
  const { ownedRedis, ownedDb, ownedMedia, ownedMailQueue } = deps;
  if (ownedRedis || ownedDb || ownedMedia || ownedMailQueue) {
    app.addHook('onClose', async () => {
      await Promise.allSettled([
        ownedMailQueue ? ownedMailQueue.close() : undefined,
        ownedMedia ? ownedMedia.close() : undefined,
        ownedRedis ? closeOwnedRedis(ownedRedis) : undefined,
        ownedDb ? ownedDb.$disconnect() : undefined,
      ]);
    });
  }
  const extensionAuth = new ExtensionAuthService({
    ...deps,
    log: deps.extensionAuthLog ?? app.log,
  });
  const desktopAuth =
    deps.desktopAuthEnabled === true
      ? new DesktopAuthService({
          ...deps,
          desktopTokens: deps.desktopTokens ?? new InMemoryExtensionTokenRepository(),
        })
      : undefined;
  // ADR-005 A1.6 (and ADR-012 when enabled): logout, password reset and member removal also revoke token families.
  const revoker = desktopAuth ? combineRevokers(extensionAuth, desktopAuth) : extensionAuth;
  const { selectNotificationsRepository } = await import('./notifications/index.js');
  const notifications = selectNotificationsRepository(deps);
  const pushDeviceRevoker = {
    async revokeForUser(userId: string, organizationId?: string | null) {
      const orgs = organizationId
        ? [organizationId]
        : (await deps.memberships.listByUser(userId)).map((m) => m.organizationId);
      for (const o of orgs) await notifications.deleteDevicesForUser(o, userId);
    },
  };
  const geoIp = deps.geoIp ?? createGeoIpProvider(process.env, app.log);
  const auth = new AuthService({ ...deps, geoIp, extensionRevoker: revoker, pushDeviceRevoker });
  const organizations = new OrganizationService({
    ...deps,
    extensionRevoker: revoker,
    pushDeviceRevoker,
  });
  if (deps.mailQueue instanceof InlineAuthMailQueue && !deps.mailQueue.handler) {
    deps.mailQueue.handler = new AuthMailJobHandler({
      ...deps,
      transport: deps.mailTransport,
      log: app.log,
    });
    deps.mailQueue.log ??= app.log;
  }
  if (deps.mailQueue instanceof BullMqAuthMailQueue) {
    deps.mailQueue.log ??= app.log;
    if (deps.authMailWorker) {
      const worker = startAuthMailWorker(
        new AuthMailJobHandler({ ...deps, transport: deps.mailTransport, log: app.log }),
        deps.authMailWorker,
        app.log,
      );
      app.addHook('onClose', async () => {
        await worker.close();
      });
    }
  }
  app.decorateRequest('auth', null);
  // ADR-012: when desktop auth is enabled the verifier also accepts desktop bearers; route guards still default to extension-only.
  const sessionVerifier = new SessionVerifier({
    ...deps,
    extensionTokenStore: desktopAuth
      ? combineBearerStores(extensionAuth.verifierStore(), desktopAuth.verifierStore())
      : extensionAuth.verifierStore(),
    ...(desktopAuth ? { bearerAudiences: ['extension', 'desktop'] as const } : {}),
  });
  // ADR-005 A1.3.1: meetings/resolve and recording/upload routes also accept the extension bearer token.
  const extensionBearer = makeExtensionBearerGuard(sessionVerifier, deps.security.cookieName);
  await app.register(authRoutes, { auth, organizations, security: deps.security });
  await app.register(organizationRoutes, { auth, organizations, security: deps.security });
  await app.register(extensionAuthRoutes, { auth, extensionAuth, security: deps.security });
  if (desktopAuth)
    await app.register(desktopAuthRoutes, { auth, desktopAuth, security: deps.security });
  await app.register(import('./directory/index.js'), { auth, organizations, deps });
  await app.register(import('./tasks/index.js'), { auth, organizations, deps });
  await app.register(import('./meeting-insights/index.js'), { auth, organizations, deps });
  await app.register(import('./integrations/index.js'), { auth, organizations, deps });
  await app.register(import('./notifications/index.js'), {
    auth,
    organizations,
    deps,
    repo: notifications,
  });
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
    desktopAuth,
  };
}
