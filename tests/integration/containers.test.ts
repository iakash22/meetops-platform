import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { Redis } from 'ioredis';
import {
  postgresAvailable,
  redisAvailable,
  startPostgres,
  startRedis,
  type PostgresService,
  type RedisService,
} from '../support/services.js';
import { createFactories } from '../factories/index.js';

const hasPg = postgresAvailable();
const hasRedis = redisAvailable();
if (!hasPg || !hasRedis)
  console.warn('[integration] Docker not available and no QA_EXTERNAL_*_URL: skipping');

describe.skipIf(!hasPg)('integration: Postgres (Testcontainers)', () => {
  let svc: PostgresService;
  let client: pg.Client;

  beforeAll(async () => {
    svc = await startPostgres();
    client = new pg.Client({ connectionString: svc.uri });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
    await svc?.stop();
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

describe.skipIf(!hasRedis)('integration: Redis (Testcontainers)', () => {
  let svc: RedisService;
  let redis: Redis;

  beforeAll(async () => {
    svc = await startRedis();
    redis = svc.redis;
  });

  afterAll(async () => {
    await svc?.stop();
  });

  it('round-trips a value', async () => {
    await redis.set('qa:ping', 'pong');
    expect(await redis.get('qa:ping')).toBe('pong');
  });
});
