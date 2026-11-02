import { describe, expect, it } from 'vitest';
import { formatStartupBanner, safeConnectionTarget } from '../src/shared/startup-banner.js';

describe('safeConnectionTarget', () => {
  it('strips credentials from postgres urls', () => {
    expect(safeConnectionTarget('postgresql://user:secret@127.0.0.1:5432/meetops')).toBe(
      '127.0.0.1:5432/meetops',
    );
  });

  it('strips credentials from redis urls', () => {
    expect(safeConnectionTarget('redis://:hunter2@127.0.0.1:6379/0')).toBe('127.0.0.1:6379/0');
  });

  it('handles empty', () => {
    expect(safeConnectionTarget(undefined)).toBe('—');
  });
});

describe('formatStartupBanner', () => {
  it('shows CONNECTED when readiness ok', () => {
    const text = formatStartupBanner({
      address: 'http://127.0.0.1:3000',
      version: '0.0.0',
      nodeEnv: 'development',
      ready: true,
      checks: { database: 'ok', redis: 'ok' },
      env: {
        DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/meetops',
        REDIS_URL: 'redis://127.0.0.1:6379',
        WEB_BASE_URL: 'http://localhost:5173',
        MEDIA_STORAGE_ENABLED: 'true',
      },
    });
    expect(text).toContain('READY');
    expect(text).toContain('CONNECTED');
    expect(text).toContain('127.0.0.1:5432/meetops');
    expect(text).not.toContain('secret');
    expect(text).not.toContain(':p@');
    expect(text).toContain('Media storage');
    expect(text).toContain('ENABLED');
    expect(text).toContain('GET /docs');
  });

  it('shows DEGRADED when a check fails', () => {
    const text = formatStartupBanner({
      address: 'http://127.0.0.1:3000',
      ready: false,
      checks: { database: 'fail', redis: 'ok' },
      env: {
        DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
        REDIS_URL: 'redis://localhost:6379',
      },
    });
    expect(text).toContain('DEGRADED');
    expect(text).toContain('FAILED');
  });
});
