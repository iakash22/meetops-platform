import { describe, it, expect } from 'vitest';
import { loadConfig, redisTlsOptions } from '../src';

// Boolean env defaults. These guard the zod 3 -> 4 migration (docs/plans/zod4-migration.md):
// zod 4's `.default()` short-circuits with the output-typed value and skips the string->boolean
// transform, so `bool.default('false')` would yield the truthy string 'false' (or `true`).
const BOOL_DEFAULTS = {
  AI_REQUIRE_PROVIDER_APPROVAL: true,
  AI_ALLOW_PAID_FALLBACK: false,
  STORAGE_FORCE_PATH_STYLE: true,
  SMTP_SECURE: true,
  OLLAMA_ENABLED: false,
  LOCAL_STT_ENABLED: false,
  OPENAI_ENABLED: false,
  DEEPGRAM_ENABLED: false,
} as const;

type BoolKey = keyof typeof BOOL_DEFAULTS;
const BOOL_KEYS = Object.keys(BOOL_DEFAULTS) as BoolKey[];

describe('config', () => {
  it('loads defaults without throwing', () => {
    const cfg = loadConfig({});
    expect(cfg.NODE_ENV).toBe('development');
    expect(cfg.STORAGE_PROVIDER).toBe('minio');
  });

  it('boolean env defaults parse to real booleans when unset', () => {
    const cfg = loadConfig({});
    for (const key of BOOL_KEYS) {
      expect(typeof cfg[key], key).toBe('boolean');
      expect(cfg[key], key).toBe(BOOL_DEFAULTS[key]);
    }
  });

  it.each(BOOL_KEYS)('%s: unset, "false" and "true" parse to the right boolean', (key) => {
    expect(loadConfig({})[key]).toBe(BOOL_DEFAULTS[key]);
    expect(loadConfig({ [key]: 'false' })[key]).toBe(false);
    expect(loadConfig({ [key]: 'true' })[key]).toBe(true);
  });

  it.each(['false', 'FALSE', '0', 'no', 'off', ''])(
    'AI_ALLOW_PAID_FALLBACK=%j parses to false',
    (v) => {
      const cfg = loadConfig({ AI_ALLOW_PAID_FALLBACK: v });
      expect(cfg.AI_ALLOW_PAID_FALLBACK).toBe(false);
      expect(typeof cfg.AI_ALLOW_PAID_FALLBACK).toBe('boolean');
    },
  );

  it.each(['true', 'TRUE', '1', 'yes', 'on'])('AI_ALLOW_PAID_FALLBACK=%j parses to true', (v) => {
    expect(loadConfig({ AI_ALLOW_PAID_FALLBACK: v }).AI_ALLOW_PAID_FALLBACK).toBe(true);
  });

  it.each(['true', '1', 'yes', 'on'])('AI_REQUIRE_PROVIDER_APPROVAL=%j parses to true', (v) => {
    expect(loadConfig({ AI_REQUIRE_PROVIDER_APPROVAL: v }).AI_REQUIRE_PROVIDER_APPROVAL).toBe(true);
  });

  it('rejects an invalid boolean string', () => {
    expect(() => loadConfig({ AI_ALLOW_PAID_FALLBACK: 'maybe' })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it('defaults SMTP_PORT to 465 and coerces numeric strings', () => {
    expect(loadConfig({}).SMTP_PORT).toBe(465);
    expect(loadConfig({ SMTP_PORT: '587' }).SMTP_PORT).toBe(587);
  });

  it('sets the TLS server name only for rediss URLs', () => {
    expect(redisTlsOptions('redis://localhost:6379')).toEqual({});
    expect(redisTlsOptions('rediss://default:secret@cache.example.test:6379')).toEqual({
      tls: { servername: 'cache.example.test' },
    });
    expect(redisTlsOptions('not a url')).toEqual({});
  });

  it('keeps postgresql:// and redis:// URL defaults and accepts overrides', () => {
    const cfg = loadConfig({});
    expect(cfg.DATABASE_URL).toBe('postgresql://postgres:postgres@localhost:5432/meetops');
    expect(cfg.REDIS_URL).toBe('redis://localhost:6379');
    expect(loadConfig({ REDIS_URL: 'rediss://cache.example.test:6380' }).REDIS_URL).toBe(
      'rediss://cache.example.test:6380',
    );
  });

  it('accepts a real postgresql:// URL with credentials and query params (zod 4 z.url())', () => {
    const url = 'postgresql://app:p%40ss@db.internal:5432/meetops?sslmode=require';
    expect(loadConfig({ DATABASE_URL: url }).DATABASE_URL).toBe(url);
  });

  it('rejects an invalid DATABASE_URL with a message naming the key but not the value', () => {
    const bad = 'not a url s3cr3t-value';
    let message = '';
    try {
      loadConfig({ DATABASE_URL: bad });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/^Invalid environment configuration/);
    expect(message).toContain('DATABASE_URL');
    expect(message).not.toContain('s3cr3t-value');
  });
});
