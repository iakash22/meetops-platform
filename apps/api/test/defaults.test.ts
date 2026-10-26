import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { DatabaseClient } from '@meetops/database';
import { fakeRedis } from './fake-redis.js';
import { createServer } from '../src/server.js';
import {
  defaultModuleDeps,
  registerModules,
  MissingProductionDependencyError,
  PRODUCTION_REQUIRED_DEPS,
  type ModuleDeps,
} from '../src/modules/index.js';
import { InMemoryAuditLog } from '../src/modules/auth/domain/audit.js';
import { PrismaAuditLog } from '../src/modules/auth/infrastructure/prisma/prisma-audit.log.js';
import { PrismaOneTimeTokenRepository } from '../src/modules/auth/infrastructure/prisma/prisma-one-time-token.repository.js';
import { PrismaSessionRepository } from '../src/modules/auth/infrastructure/prisma/prisma-session.repository.js';
import { PrismaUserRepository } from '../src/modules/users/infrastructure/prisma/prisma-user.repository.js';
import {
  PrismaInvitationRepository,
  PrismaMembershipRepository,
  PrismaOrganizationRepository,
} from '../src/modules/organizations/infrastructure/prisma/prisma.repositories.js';
import {
  InMemoryRateLimiter,
  InMemoryLoginLockout,
} from '../src/modules/auth/infrastructure/rate-limit/in-memory.js';
import {
  RedisLoginLockout,
  RedisRateLimiter,
} from '../src/modules/auth/infrastructure/rate-limit/redis.js';
import { InMemoryUserRepository } from '../src/modules/users/infrastructure/in-memory-user.repository.js';

// Unreachable on purpose: Prisma and ioredis (lazyConnect) only connect on first use, and these
// tests never issue a query, so they need no infrastructure.
const DB_URL = 'postgresql://unit:unit@127.0.0.1:1/unit';
const REDIS_URL = 'redis://127.0.0.1:1';

const missingFor = (
  overrides: Partial<ModuleDeps>,
  env: Parameters<typeof defaultModuleDeps>[1],
) => {
  try {
    defaultModuleDeps(overrides, env);
  } catch (e) {
    if (e instanceof MissingProductionDependencyError) return e.missing;
    throw e;
  }
  return [];
};

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

/** Builds deps and registers their shutdown hooks on a bare Fastify instance (closed after each test). */
async function withShutdown(deps: ModuleDeps) {
  const app = Fastify();
  await registerModules(app, deps);
  await app.ready();
  closers.push(() => app.close());
  return app;
}

describe('BE-1: strict environments without DATABASE_URL / REDIS_URL', () => {
  it('lists every required implementation, audit and rateLimiter included', () => {
    const missing = missingFor({}, { nodeEnv: 'production' });
    expect(missing).toEqual([...PRODUCTION_REQUIRED_DEPS]);
    expect(missing).toEqual(expect.arrayContaining(['audit', 'rateLimiter', 'lockout']));
  });

  it('DATABASE_URL alone satisfies persistence and audit, not rate limiting or the mail queue', () => {
    expect(missingFor({}, { nodeEnv: 'production', databaseUrl: DB_URL })).toEqual([
      'rateLimiter',
      'lockout',
      'mailQueue',
    ]);
  });

  it('REDIS_URL alone satisfies the rate limiter and lockout only', () => {
    expect(missingFor({}, { nodeEnv: 'staging', redisUrl: REDIS_URL })).toEqual([
      'users',
      'sessions',
      'oneTimeTokens',
      'organizations',
      'memberships',
      'invitations',
      'meetings',
      'mailQueue',
      'audit',
    ]);
  });

  it('DATABASE_URL + REDIS_URL leave only the mail queue to inject', () => {
    expect(
      missingFor({}, { nodeEnv: undefined, databaseUrl: DB_URL, redisUrl: REDIS_URL }),
    ).toEqual(['mailQueue']);
  });

  it('createServer reads DATABASE_URL / REDIS_URL (or its overrides) for the same check', () => {
    expect(() =>
      createServer({ nodeEnv: 'production', databaseUrl: DB_URL, redisUrl: REDIS_URL }),
    ).toThrow(/implementations for: mailQueue$/);
  });
});

describe('BE-1: Prisma and Redis become the defaults when configured', () => {
  it('DATABASE_URL (outside test) wires every Prisma repository and the Prisma audit log', async () => {
    const deps = defaultModuleDeps({}, { nodeEnv: 'development', databaseUrl: DB_URL });
    await withShutdown(deps);
    expect(deps.users).toBeInstanceOf(PrismaUserRepository);
    expect(deps.sessions).toBeInstanceOf(PrismaSessionRepository);
    expect(deps.oneTimeTokens).toBeInstanceOf(PrismaOneTimeTokenRepository);
    expect(deps.organizations).toBeInstanceOf(PrismaOrganizationRepository);
    expect(deps.memberships).toBeInstanceOf(PrismaMembershipRepository);
    expect(deps.invitations).toBeInstanceOf(PrismaInvitationRepository);
    expect(deps.audit).toBeInstanceOf(PrismaAuditLog);
    expect(deps.db).toBeDefined();
    expect(deps.ownedDb).toBe(deps.db);
    // No Redis configured: rate limiting stays in-memory (development only).
    expect(deps.rateLimiter).toBeInstanceOf(InMemoryRateLimiter);
  });

  it('REDIS_URL (outside test) wires RedisRateLimiter and RedisLoginLockout', async () => {
    const deps = defaultModuleDeps({}, { nodeEnv: 'development', redisUrl: REDIS_URL });
    await withShutdown(deps);
    expect(deps.rateLimiter).toBeInstanceOf(RedisRateLimiter);
    expect(deps.lockout).toBeInstanceOf(RedisLoginLockout);
    expect(deps.ownedRedis).toBeDefined();
    expect(deps.users).toBeInstanceOf(InMemoryUserRepository);
  });

  it('an injected Redis client gives the Redis rate limiter too (G12)', () => {
    const deps = defaultModuleDeps({ redis: fakeRedis() }, { nodeEnv: 'test' });
    expect(deps.rateLimiter).toBeInstanceOf(RedisRateLimiter);
    expect(deps.ownedRedis).toBeUndefined();
  });

  it('an injected Prisma client gives the Prisma repositories even under test, and is not owned', () => {
    const db = {} as DatabaseClient;
    const deps = defaultModuleDeps({ db }, { nodeEnv: 'test' });
    expect(deps.users).toBeInstanceOf(PrismaUserRepository);
    expect(deps.audit).toBeInstanceOf(PrismaAuditLog);
    expect(deps.db).toBe(db);
    expect(deps.ownedDb).toBeUndefined();
  });

  it('injected implementations still win over the clients', () => {
    const audit = new InMemoryAuditLog();
    const rateLimiter = new InMemoryRateLimiter({ now: () => new Date() });
    const deps = defaultModuleDeps(
      { audit, rateLimiter, db: {} as DatabaseClient, redis: fakeRedis() },
      { nodeEnv: 'test' },
    );
    expect(deps.audit).toBe(audit);
    expect(deps.rateLimiter).toBe(rateLimiter);
    expect(deps.users).toBeInstanceOf(PrismaUserRepository);
  });

  it('creates no client when every backed dependency is injected', () => {
    // Test-env deps are all in-memory and carry no client of their own.
    const injected = defaultModuleDeps({}, { nodeEnv: 'test' });
    const deps = defaultModuleDeps(injected, {
      nodeEnv: 'development',
      databaseUrl: DB_URL,
      redisUrl: REDIS_URL,
    });
    expect(deps.ownedDb).toBeUndefined();
    expect(deps.ownedRedis).toBeUndefined();
  });

  it('in-memory stays the default under NODE_ENV=test even with both URLs set', () => {
    const deps = defaultModuleDeps(
      {},
      { nodeEnv: 'test', databaseUrl: DB_URL, redisUrl: REDIS_URL },
    );
    expect(deps.users).toBeInstanceOf(InMemoryUserRepository);
    expect(deps.audit).toBeInstanceOf(InMemoryAuditLog);
    expect(deps.rateLimiter).toBeInstanceOf(InMemoryRateLimiter);
    expect(deps.lockout).toBeInstanceOf(InMemoryLoginLockout);
    expect(deps.db).toBeUndefined();
    expect(deps.ownedRedis).toBeUndefined();
  });

  it('an explicit env object replaces process.env (no DATABASE_URL leak into unit tests)', () => {
    const deps = defaultModuleDeps({}, { nodeEnv: 'development' });
    expect(deps.users).toBeInstanceOf(InMemoryUserRepository);
    expect(deps.db).toBeUndefined();
  });
});

describe('BE-1: shutdown closes only the clients it created', () => {
  it('app.close() disconnects the owned Prisma client and drops the owned Redis client', async () => {
    const deps = defaultModuleDeps(
      {},
      { nodeEnv: 'development', databaseUrl: DB_URL, redisUrl: REDIS_URL },
    );
    const disconnect = vi.spyOn(deps.ownedDb!, '$disconnect');
    const app = Fastify();
    await registerModules(app, deps);
    await app.ready();
    expect(deps.ownedRedis?.status).toBe('wait');
    await app.close();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(deps.ownedRedis?.status).toBe('end');
  });

  it('injected clients are left open for their owner', async () => {
    const $disconnect = vi.fn(async () => {});
    const redis = fakeRedis();
    const quit = vi.fn();
    Object.assign(redis, { quit });
    const deps = defaultModuleDeps(
      { db: { $disconnect } as unknown as DatabaseClient, redis },
      { nodeEnv: 'test' },
    );
    const app = Fastify();
    await registerModules(app, deps);
    await app.ready();
    await app.close();
    expect($disconnect).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });

  it('createServer passes the URLs through and closes what it created', async () => {
    const app = createServer({ nodeEnv: 'development', databaseUrl: DB_URL, redisUrl: REDIS_URL });
    await app.ready();
    await expect(app.close()).resolves.toBeUndefined();
  });
});
