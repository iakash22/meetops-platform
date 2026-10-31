import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schema = readFileSync(resolve(pkgDir, 'prisma/schema.prisma'), 'utf8');
const migrationsDir = resolve(pkgDir, 'prisma/migrations');

describe('MeetingSource enum (mobile)', () => {
  it('schema enum lists the contract values', () => {
    const body = /enum MeetingSource \{([^}]*)\}/.exec(schema)?.[1] ?? '';
    expect(body.split(/\s+/).filter(Boolean)).toEqual([
      'upload',
      'extension',
      'desktop',
      'bot',
      'mobile',
    ]);
  });

  it('an additive migration adds mobile after the type was created', () => {
    const dirs = readdirSync(migrationsDir)
      .filter((d) => /^\d{14}_/.test(d))
      .sort();
    const create = dirs.findIndex((d) =>
      readFileSync(resolve(migrationsDir, d, 'migration.sql'), 'utf8').includes(
        'CREATE TYPE "MeetingSource"',
      ),
    );
    const add = dirs.findIndex((d) =>
      readFileSync(resolve(migrationsDir, d, 'migration.sql'), 'utf8').includes(
        `ALTER TYPE "MeetingSource" ADD VALUE IF NOT EXISTS 'mobile';`,
      ),
    );
    expect(create).toBeGreaterThanOrEqual(0);
    expect(add).toBeGreaterThan(create);
  });
});
