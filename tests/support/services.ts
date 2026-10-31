/**
 * Service provider for the integration suites.
 *
 * Default (no env vars): each suite starts its own Testcontainers Postgres / Redis, exactly as
 * before. When `QA_EXTERNAL_DB_URL` / `QA_EXTERNAL_REDIS_URL` are set, Testcontainers is skipped
 * for that service and an already-running server is used instead, without touching existing data:
 *
 * - Postgres: a throwaway database `qa_it_<random>` is created per suite (the URL's user needs
 *   CREATEDB, and CREATEROLE for the RLS login roles). Migrations run there. Teardown terminates
 *   its sessions and drops it. Login roles the suites create are suffixed with the run id and
 *   dropped in teardown. Roles that already exist (e.g. meetops_app) are never altered or dropped.
 * - Redis: every key is namespaced with a unique `qa:it:<random>:` prefix (ioredis `keyPrefix`).
 *   Teardown SCANs and deletes only that prefix. It never calls FLUSHALL / FLUSHDB.
 *
 * Never commit these URLs: pass them through the environment only.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Redis } from 'ioredis';
import { isDockerAvailable } from './env.js';

const POSTGRES_IMAGE = () => process.env.QA_POSTGRES_IMAGE ?? 'pgvector/pgvector:pg16';
const REDIS_IMAGE = () => process.env.QA_REDIS_IMAGE ?? 'redis:7-alpine';

export const externalDbUrl = () => process.env.QA_EXTERNAL_DB_URL || undefined;
export const externalRedisUrl = () => process.env.QA_EXTERNAL_REDIS_URL || undefined;

/** Postgres is usable: an external URL is set, or Docker is available (strict in CI). */
export const postgresAvailable = (): boolean => !!externalDbUrl() || isDockerAvailable();
/** Redis is usable: an external URL is set, or Docker is available (strict in CI). */
export const redisAvailable = (): boolean => !!externalRedisUrl() || isDockerAvailable();

const runId = () => randomBytes(6).toString('hex');

export type PostgresService = {
  /** Superuser/owner connection URI for the database the suite should use. */
  uri: string;
  /** Unique suffix for cluster-global objects (roles) the suite creates. '' for containers. */
  suffix: string;
  /** Register a LOGIN role created by the suite so teardown drops it (external mode only). */
  trackRole(name: string): void;
  external: boolean;
  stop(): Promise<void>;
};

async function withAdmin<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`unsafe identifier: ${s}`);
  return `"${s}"`;
};

export async function startPostgres(): Promise<PostgresService> {
  const ext = externalDbUrl();
  if (!ext) {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const container = await new PostgreSqlContainer(POSTGRES_IMAGE()).start();
    return {
      uri: container.getConnectionUri(),
      suffix: '',
      trackRole: () => {},
      external: false,
      stop: async () => {
        await container.stop();
      },
    };
  }

  const id = runId();
  const dbName = `qa_it_${id}`;
  const roles: string[] = [];
  const dbUrl = new URL(ext);
  dbUrl.pathname = `/${dbName}`;
  await withAdmin(ext, (c) => c.query(`CREATE DATABASE ${ident(dbName)}`));
  return {
    uri: dbUrl.toString(),
    suffix: `_${id}`,
    trackRole: (name) => {
      ident(name);
      roles.push(name);
    },
    external: true,
    stop: async () => {
      await withAdmin(ext, async (c) => {
        await c.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
          [dbName],
        );
        await c.query(`DROP DATABASE IF EXISTS ${ident(dbName)}`);
        for (const r of roles) await c.query(`DROP ROLE IF EXISTS ${ident(r)}`);
      });
    },
  };
}

export type RedisService = {
  /** Client whose keys are all namespaced under `prefix` in external mode. */
  redis: Redis;
  prefix: string;
  external: boolean;
  stop(): Promise<void>;
};

export async function startRedis(): Promise<RedisService> {
  const ext = externalRedisUrl();
  if (!ext) {
    const { RedisContainer } = await import('@testcontainers/redis');
    const container = await new RedisContainer(REDIS_IMAGE()).start();
    const redis = new Redis(container.getConnectionUrl());
    return {
      redis,
      prefix: '',
      external: false,
      stop: async () => {
        redis.disconnect();
        await container.stop();
      },
    };
  }

  const prefix = `qa:it:${runId()}:`;
  const redis = new Redis(ext, { keyPrefix: prefix, lazyConnect: true });
  await redis.connect();
  return {
    redis,
    prefix,
    external: true,
    stop: async () => {
      // A separate un-prefixed client, so SCAN MATCH sees the full key names. Only our prefix.
      const admin = new Redis(ext);
      try {
        let cursor = '0';
        do {
          const [next, keys] = await admin.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
          cursor = next;
          if (keys.length) await admin.del(...keys);
        } while (cursor !== '0');
      } finally {
        admin.disconnect();
        redis.disconnect();
      }
    },
  };
}
