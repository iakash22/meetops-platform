import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, it, expect, afterAll } from 'vitest';
import * as db from '../src/index.js';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://meetops:meetops@localhost:5432/meetops',
};
const prisma = (...args: string[]) =>
  execFileSync('pnpm', ['exec', 'prisma', ...args], { cwd: pkgDir, env, encoding: 'utf8', stdio: 'pipe' });

describe('prisma schema', () => {
  it('validates', () => {
    expect(prisma('validate')).toMatch(/is valid/);
  }, 60_000);

  it('generates the client', () => {
    expect(prisma('generate')).toMatch(/Generated Prisma Client/);
  }, 120_000);

  it('initial migration enables pgvector', () => {
    const sql = readFileSync(
      resolve(pkgDir, 'prisma/migrations/20261021000000_init_core_schema/migration.sql'),
      'utf8',
    );
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS "vector"');
    expect(sql).toContain('"embedding" vector(1536)');
  });
});

describe('generated client', () => {
  afterAll(async () => {
    await db.disconnectPrismaClient();
  });

  it('exposes exactly the 20 core models', () => {
    const models = Object.values(db.Prisma.ModelName);
    expect(models).toHaveLength(20);
    for (const m of [
      'Organization', 'User', 'Membership', 'Session', 'Invitation', 'Employee', 'Project',
      'Meeting', 'MeetingParticipant', 'FileObject', 'Transcript', 'TranscriptSegment', 'Report',
      'ExtractedTask', 'TaskApproval', 'InternalTask', 'ExternalIssueLink', 'AiRun', 'OutboxEvent', 'AuditLog',
    ]) {
      expect(models).toContain(m);
    }
  });

  it('exposes enums', () => {
    expect(Object.values(db.MembershipRole)).toEqual(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']);
    expect(db.AiRunStatus.SUCCEEDED).toBe('SUCCEEDED');
    expect(db.ExternalProvider.LINEAR).toBe('LINEAR');
  });

  it('returns a singleton client without connecting', () => {
    const a = db.getPrismaClient();
    expect(a).toBe(db.getPrismaClient());
    expect(a).toBeInstanceOf(db.PrismaClient);
  });
});
