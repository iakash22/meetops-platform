import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, it, expect, afterAll } from 'vitest';
import { Prisma, PrismaClient, MembershipRole, AiRunStatus, TaskStatus } from '@prisma/client';
import * as db from '../src/index.js';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = {
  ...process.env,
  DATABASE_URL:
    process.env.DATABASE_URL ??
    'postgresql://meetops_app:change-me-app-local@localhost:5432/meetops',
  MIGRATION_DATABASE_URL:
    process.env.MIGRATION_DATABASE_URL ??
    'postgresql://meetops_migrator:change-me-migrator-local@localhost:5432/meetops',
};
const prisma = (...args: string[]) =>
  execFileSync('pnpm', ['exec', 'prisma', ...args], {
    cwd: pkgDir,
    env,
    encoding: 'utf8',
    stdio: 'pipe',
  });

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

  it('exposes exactly the 43 models', () => {
    const models = Object.values(Prisma.ModelName);
    expect(models).toHaveLength(43);
    for (const m of [
      'Organization',
      'User',
      'Membership',
      'Session',
      'Invitation',
      'Employee',
      'Project',
      'Meeting',
      'MeetingParticipant',
      'FileObject',
      'Transcript',
      'TranscriptSegment',
      'Report',
      'ExtractedTask',
      'TaskApproval',
      'Task',
      'IntegrationIssue',
      'Recording',
      'RecordingSession',
      'RecordingSessionChunk',
      'EmailVerification',
      'PasswordReset',
      'AiRun',
      'OutboxEvent',
      'AuditEvent',
      'AiUsageCounter',
      'AiOrganizationConfig',
      'AiIdempotency',
      'TranscriptChunk',
      'Team',
      'TeamMember',
      'ConsentAttestation',
      'AuthDevice',
      'AuthTokenFamily',
      'AuthRefreshToken',
      'Notification',
      'NotificationDeliveryAttempt',
      'NotificationPreference',
      'PushDeviceToken',
      'CalendarEvent',
      'MeetingConsentEvent',
    ]) {
      expect(models).toContain(m);
    }
  });

  it('exposes enums', () => {
    expect(Object.values(MembershipRole)).toEqual(['owner', 'admin', 'member', 'viewer']);
    expect(AiRunStatus.succeeded).toBe('succeeded');
    expect(Object.values(TaskStatus)).toEqual(['todo', 'in_progress', 'done', 'cancelled']);
  });

  it('exports only the minimal runtime API', () => {
    expect(Object.keys(db).sort()).toEqual(
      [
        'MEETINGS_PAGE_DEFAULT_LIMIT',
        'MEETINGS_PAGE_MAX_LIMIT',
        'RECORDING_SESSION_BYTES_ERRORS',
        'addRecordingSessionBytes',
        'clampMeetingsLimit',
        'createPrismaClient',
        'decodeMeetingsCursor',
        'disconnectPrismaClient',
        'encodeMeetingsCursor',
        'listMeetingsPage',
        'getPrismaClient',
        'withOrgContext',
        'withOrganizationContext',
        'createTranscriptRepository',
        'truncateChunkError',
        'TRANSCRIPT_CHUNK_ERROR_MAX',
        'createAiUsageCounterRepository',
        'createAiIdempotencyRepository',
        'createRecordingChunkCountRepository',
        'createChunkFileObjectRepository',
        'createChunkFileObjectLookup',
        'createRecordingOwnershipVerifier',
        'createRecordingChunkPersistence',
        'MediaPersistenceError',
        'MAX_RECORDING_CHUNKS',
        'withUserContext',
        'createEmployeeRepository',
        'createTeamRepository',
        'createTeamMemberRepository',
        'createProjectRepository',
        'createCalendarSyncRepository',
        'createIntegrationConnectionRepository',
        'DirectoryError',
        'createAuthTokenRepository',
        'AuthTokenHashError',
        'AUTH_TOKEN_AUDIENCES',
        'isDirectoryError',
        'DIRECTORY_DEFAULT_PAGE_LIMIT',
        'DIRECTORY_MAX_PAGE_LIMIT',
        'createNotificationRepository',
        'hashPushToken',
        'encodeNotificationCursor',
        'decodeNotificationCursor',
        'NOTIFICATIONS_DEFAULT_PAGE_LIMIT',
        'NOTIFICATIONS_MAX_PAGE_LIMIT',
        'NOTIFICATION_PREFERENCES_MAX',
        'IP_RETENTION_DAYS',
        'IP_RETENTION_BATCH',
        'IP_RETENTION_MAX_BATCHES',
        'redactExpiredIpAddresses',
        'SESSION_PURGE_DAYS',
        'SESSION_PURGE_BATCH',
        'SESSION_PURGE_MAX_BATCHES',
        'purgeExpiredSessions',
      ].sort(),
    );
  });

  it('returns a singleton client without connecting', () => {
    const a = db.getPrismaClient();
    expect(a).toBe(db.getPrismaClient());
    expect(a).toBeInstanceOf(PrismaClient);
  });
});

describe('lint wiring', () => {
  it('tsconfig.json excludes test/ (root eslint allowDefaultProject owns packages/*/test/*.ts); tsconfig.test.json typechecks it', () => {
    const tsconfig = JSON.parse(
      readFileSync(new URL('../tsconfig.json', import.meta.url), 'utf8'),
    ) as { include: string[] };
    const testConfig = JSON.parse(
      readFileSync(new URL('../tsconfig.test.json', import.meta.url), 'utf8'),
    ) as { include: string[] };
    expect(tsconfig.include.some((p) => p.startsWith('test'))).toBe(false);
    expect(testConfig.include).toContain('test');
  });
});
