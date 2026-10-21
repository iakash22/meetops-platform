/**
 * Cross-platform (Windows/macOS/Linux) equivalent of create-db-roles.sh; needs no psql.
 *   pnpm --filter @meetops/database db:roles
 * Env: ADMIN_DATABASE_URL (superuser, maintenance DB), MEETOPS_APP_PASSWORD, MEETOPS_MIGRATOR_PASSWORD
 * (required), MEETOPS_RELAY_PASSWORD (optional), MEETOPS_DB_NAME (default "meetops").
 * Passwords are sent as bind parameters and quoted server-side with format(%L); never logged.
 */
import { PrismaClient } from '@prisma/client';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

type Role = { name: string; password: string; attrs: string };

export async function createDbRoles(env = process.env): Promise<void> {
  const adminUrl = required('ADMIN_DATABASE_URL');
  const dbName = env.MEETOPS_DB_NAME ?? 'meetops';
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(dbName)) throw new Error('MEETOPS_DB_NAME must be a simple identifier');
  const roles: Role[] = [
    { name: 'meetops_migrator', password: required('MEETOPS_MIGRATOR_PASSWORD'), attrs: 'LOGIN NOSUPERUSER NOBYPASSRLS CREATEDB' },
    { name: 'meetops_app', password: required('MEETOPS_APP_PASSWORD'), attrs: 'LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE' },
  ];
  if (env.MEETOPS_RELAY_PASSWORD) {
    roles.push({ name: 'meetops_relay', password: env.MEETOPS_RELAY_PASSWORD, attrs: 'LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE' });
  }

  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } });
  try {
    for (const r of roles) {
      const exists = await admin.$queryRaw<unknown[]>`SELECT 1 FROM pg_roles WHERE rolname = ${r.name}`;
      if (exists.length === 0) await admin.$executeRawUnsafe(`CREATE ROLE ${r.name}`);
      const [stmt] = await admin.$queryRaw<{ sql: string }[]>`
        SELECT format('ALTER ROLE %I ' || ${r.attrs} || ' PASSWORD %L', ${r.name}::text, ${r.password}::text) AS sql`;
      if (!stmt) throw new Error('failed to build ALTER ROLE');
      await admin.$executeRawUnsafe(stmt.sql);
    }
    const db = await admin.$queryRaw<unknown[]>`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
    if (db.length === 0) await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}" OWNER meetops_migrator`);
    // With compose.dev.yml the DB already exists (POSTGRES_DB) owned by POSTGRES_USER: hand it over.
    else await admin.$executeRawUnsafe(`ALTER DATABASE "${dbName}" OWNER TO meetops_migrator`);
  } finally {
    await admin.$disconnect();
  }

  const target = new PrismaClient({ datasources: { db: { url: withDatabase(adminUrl, dbName) } } });
  try {
    await target.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS vector');
    await target.$executeRawUnsafe('ALTER SCHEMA public OWNER TO meetops_migrator');
  } finally {
    await target.$disconnect();
  }
  console.warn(`MeetOps roles (${roles.map((r) => r.name).join(', ')}) and database "${dbName}" are up to date.`);
}

createDbRoles().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'create-db-roles failed');
  process.exitCode = 1;
});
