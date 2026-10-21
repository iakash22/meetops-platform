import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Location of the @meetops/database package that owns the Prisma schema.
 * Defaults to packages/database in this checkout. Override with QA_DB_PACKAGE_DIR
 * (e.g. a read-only worktree of PR #6's feat/database-core-schema branch).
 */
export const dbPackageDir = resolve(
  process.env.QA_DB_PACKAGE_DIR ?? join(here, '../../packages/database'),
);
const migrationsDir = join(dbPackageDir, 'prisma/migrations');
export const seedFile = join(dbPackageDir, 'prisma/seed.ts');

/** Migration SQL files in apply order (Prisma folder names are timestamp-prefixed). */
export function migrationFiles(): string[] {
  if (!existsSync(migrationsDir)) return [];
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(migrationsDir, d.name, 'migration.sql')))
    .map((d) => join(migrationsDir, d.name, 'migration.sql'))
    .sort();
}

export const hasMigrations = () => migrationFiles().length > 0;

/** Seed needs the package's own tsx + generated Prisma client (pnpm install in that package). */
export const canSeed = () =>
  existsSync(seedFile) &&
  existsSync(join(dbPackageDir, 'node_modules/.bin/tsx')) &&
  existsSync(join(dbPackageDir, 'node_modules/@prisma/client'));

export const readSql = (file: string) => readFileSync(file, 'utf8');
