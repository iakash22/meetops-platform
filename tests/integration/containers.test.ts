import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import pg from 'pg';
import { Redis } from 'ioredis';
import { isDockerAvailable } from '../support/env.js';
import { createFactories } from '../factories/index.js';

const docker = isDockerAvailable();
if (!docker) console.warn('[integration] Docker not available: skipping Testcontainers suites');

describe.skipIf(!docker)('integration: Postgres (Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let client: pg.Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(
      process.env.QA_POSTGRES_IMAGE ?? 'pgvector/pgvector:pg16',
    ).start();
    client = new pg.Client({ connectionString: container.getConnectionUri() });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('stores organization-scoped rows from the factory', async () => {
    const f = createFactories({ seed: 9, organizationSlug: 'pg' });
    await client.query(
      'CREATE TABLE objects (organization_id text NOT NULL, key text PRIMARY KEY)',
    );
    const obj = f.storageObject();
    await client.query('INSERT INTO objects VALUES ($1, $2)', [f.organization.id, obj.key]);
    const res = await client.query('SELECT key FROM objects WHERE organization_id = $1', [
      f.organization.id,
    ]);
    expect(res.rows).toEqual([{ key: obj.key }]);
  });
});

describe.skipIf(!docker)('integration: Redis (Testcontainers)', () => {
  let container: StartedRedisContainer;
  let redis: Redis;

  beforeAll(async () => {
    container = await new RedisContainer(process.env.QA_REDIS_IMAGE ?? 'redis:7-alpine').start();
    redis = new Redis(container.getConnectionUrl());
  });

  afterAll(async () => {
    redis?.disconnect();
    await container?.stop();
  });

  it('round-trips a value', async () => {
    await redis.set('qa:ping', 'pong');
    expect(await redis.get('qa:ping')).toBe('pong');
  });
});
