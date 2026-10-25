import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertMediaWorkerDatabaseEnv,
  loadMediaWorkerConfig,
  startMediaWorker,
} from '../src/media/index.js';

describe('media worker database fail-fast', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('accepts postgres:// and postgresql:// URLs', () => {
    expect(() =>
      assertMediaWorkerDatabaseEnv({ DATABASE_URL: 'postgresql://app@db:5432/meetops' }),
    ).not.toThrow();
    expect(() =>
      assertMediaWorkerDatabaseEnv({ DATABASE_URL: 'postgres://app@db/meetops' }),
    ).not.toThrow();
  });

  it('rejects a missing or blank DATABASE_URL', () => {
    expect(() => assertMediaWorkerDatabaseEnv({})).toThrow(/DATABASE_URL is required/);
    expect(() => assertMediaWorkerDatabaseEnv({ DATABASE_URL: '  ' })).toThrow(
      /DATABASE_URL is required/,
    );
  });

  it('rejects a non-postgres URL without echoing it', () => {
    const secret = 'mysql://user:hunter2@db/x';
    let message = '';
    try {
      assertMediaWorkerDatabaseEnv({ DATABASE_URL: secret });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/postgres:\/\/ or postgresql:\/\//);
    expect(message).not.toContain('hunter2');
  });

  it('startMediaWorker throws at startup, before connecting to Redis, when DATABASE_URL is unset', () => {
    vi.stubEnv('DATABASE_URL', '');
    expect(() =>
      startMediaWorker(loadMediaWorkerConfig({ REDIS_URL: 'redis://127.0.0.1:1' })),
    ).toThrow(/DATABASE_URL is required/);
  });
});
