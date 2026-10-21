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

const prismaBin = () => join(dbPackageDir, 'node_modules/.bin/prisma');

/** True when the schema includes forced row level security (PR #25 and later). */
export const hasRlsMigration = () =>
  migrationFiles().some((f) => /FORCE ROW LEVEL SECURITY/i.test(readSql(f)));

/**
 * Apply migrations the way production does: `prisma migrate deploy` when the package has
 * its Prisma CLI installed (creates _prisma_migrations, which later migrations reference),
 * otherwise each migration.sql in order via the given pg client.
 */
export async function applyMigrations(
  url: string,
  client: { query: (sql: string) => Promise<unknown> },
): Promise<'prisma' | 'sql'> {
  if (existsSync(prismaBin())) {
    const { execFileSync } = await import('node:child_process');
    execFileSync(prismaBin(), ['migrate', 'deploy'], {
      cwd: dbPackageDir,
      env: { ...process.env, DATABASE_URL: url, MIGRATION_DATABASE_URL: url },
      stdio: 'pipe',
      timeout: 120_000,
    });
    return 'prisma';
  }
  for (const file of migrationFiles()) await client.query(readSql(file));
  return 'sql';
}

/**
 * Workaround mode for QA_RLS_SCHEMA=datamodel: build tables straight from schema.prisma
 * (`prisma migrate diff --from-empty`), then apply only the RLS migration(s). Use it when the
 * migration chain itself is broken so RLS policies can still be exercised. It is NOT a
 * substitute for `migrate deploy` passing.
 */
export async function applyDatamodelPlusRls(client: {
  query: (sql: string) => Promise<unknown>;
}): Promise<void> {
  const { execFileSync } = await import('node:child_process');
  const sql = execFileSync(
    prismaBin(),
    [
      'migrate',
      'diff',
      '--from-empty',
      '--to-schema-datamodel',
      'prisma/schema.prisma',
      '--script',
    ],
    { cwd: dbPackageDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 },
  );
  await client.query(sql);
  // The RLS migration revokes on Prisma's bookkeeping table, which only migrate deploy creates.
  await client.query('CREATE TABLE IF NOT EXISTS "_prisma_migrations" (id text PRIMARY KEY)');
  for (const f of migrationFiles().filter((m) => /FORCE ROW LEVEL SECURITY/i.test(readSql(m))))
    await client.query(readSql(f));
}
