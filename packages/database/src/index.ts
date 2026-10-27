import type { Prisma, PrismaClient } from '@prisma/client';
import {
  runWithOrganizationContext,
  runWithUserContext,
  type OrganizationContextOptions,
  type OrgContextOptions,
} from './tenant.js';
import { getPrismaClient } from './client.js';

/** The database client type. Model/enum types come from @meetops/contracts, not from here. */
export type DatabaseClient = PrismaClient;
/** Transaction-scoped client passed to withOrganizationContext callbacks. */
export type DatabaseTransaction = Prisma.TransactionClient;
export type { OrganizationContextOptions, OrgContextOptions };

export {
  createPrismaClient,
  disconnectPrismaClient,
  getPrismaClient,
  type CreatePrismaClientOptions,
} from './client.js';
/**
 * withOrganizationContext(organizationId, fn, { client?, userId?, timeoutMs? }): run fn in one interactive
 * transaction with app.current_organization_id set LOCAL, so forced RLS only exposes this organization.
 * Uses the shared client unless one is passed.
 */
export async function withOrganizationContext<T>(
  organizationId: string,
  fn: (tx: DatabaseTransaction) => Promise<T>,
  options: OrganizationContextOptions = {},
): Promise<T> {
  const { client, ...rest } = options;
  return runWithOrganizationContext(client ?? getPrismaClient(), organizationId, fn, rest);
}

/**
 * @deprecated Use withOrganizationContext (ADR-010). Kept for one minor version; same behavior.
 */
export async function withOrgContext<T>(
  organizationId: string,
  fn: (tx: DatabaseTransaction) => Promise<T>,
  options: OrganizationContextOptions = {},
): Promise<T> {
  return withOrganizationContext(organizationId, fn, options);
}

/**
 * withUserContext(userId, fn, { client?, timeoutMs? }): run fn in one transaction with
 * app.current_user_id set LOCAL, for cross-org reads of the user's own memberships.
 */
export async function withUserContext<T>(
  userId: string,
  fn: (tx: DatabaseTransaction) => Promise<T>,
  options: Pick<OrganizationContextOptions, 'client' | 'timeoutMs'> = {},
): Promise<T> {
  const { client, ...rest } = options;
  return runWithUserContext(client ?? getPrismaClient(), userId, fn, rest);
}

export {
  createTranscriptRepository,
  truncateChunkError,
  TRANSCRIPT_CHUNK_ERROR_MAX,
  type TranscriptRepository,
  type TranscriptChunkRecord,
  type TranscriptChunkStatus,
  type UpsertChunkInput,
  type MarkChunkInput,
  type CompleteMergeInput,
  type RepositoryOptions,
} from './transcript-repository.js';
export {
  createAiUsageCounterRepository,
  createAiIdempotencyRepository,
  type AiUsageCounterRepository,
  type AiIdempotencyRepository,
  type AiUsageDelta,
  type AiUsagePeriodKind,
  type AiIdempotencyStatus,
} from './ai.js';
export {
  createRecordingChunkCountRepository,
  createChunkFileObjectRepository,
  createChunkFileObjectLookup,
  createRecordingOwnershipVerifier,
  createRecordingChunkPersistence,
  MediaPersistenceError,
  MAX_RECORDING_CHUNKS,
  type ChunkFileObjectRow,
  type ChunkFileObjectRepository,
  type ChunkFileObjectRepositoryOptions,
  type RecordingChunkCountRepository,
  type ChunkFileObjectRecord,
  type ChunkFileObjectLookup,
  type MediaRepositoryOptions,
  type RecordingRef,
  type RecordingOwnershipVerifier,
  type RecordingChunkPersistence,
} from './media.js';
export {
  createEmployeeRepository,
  createTeamRepository,
  createTeamMemberRepository,
  createProjectRepository,
  DirectoryError,
  isDirectoryError,
  DIRECTORY_DEFAULT_PAGE_LIMIT,
  DIRECTORY_MAX_PAGE_LIMIT,
  type DirectoryErrorReason,
  type DirectoryErrorKind,
  type DirectoryPage,
  type DirectoryPageQuery,
  type EmployeeRepository,
  type EmployeeRecord,
  type CreateEmployeeInput,
  type UpdateEmployeeInput,
  type ListEmployeesInput,
  type TeamRepository,
  type TeamRecord,
  type CreateTeamInput,
  type UpdateTeamInput,
  type ListTeamsInput,
  type TeamMemberRepository,
  type TeamMemberRecord,
  type DirectoryTeamMemberRole,
  type ListTeamMembersInput,
  type ProjectRepository,
  type ProjectRecord,
  type DirectoryProjectStatus,
  type CreateProjectInput,
  type UpdateProjectInput,
  type ListProjectsInput,
} from './directory.js';
export {
  createIntegrationConnectionRepository,
  type IntegrationConnectionRepository,
  type IntegrationConnectionRepositoryOptions,
  type IntegrationConnectionRecord,
  type IntegrationConnectionStatusValue,
  type IntegrationSecretCipher,
  type IntegrationSecrets,
  type UpsertIntegrationConnectionInput,
} from './integration-connections.js';
export {
  createAuthTokenRepository,
  AuthTokenHashError,
  AUTH_TOKEN_AUDIENCES,
  type AuthTokenRepository,
  type AuthTokenAudience,
  type AuthTokenFamilyRecord,
  type AuthDeviceInput,
  type CreateAuthTokenFamilyInput,
  type AuthRefreshConsumeResult,
} from './auth-tokens.js';
export {
  listMeetingsPage,
  encodeMeetingsCursor,
  decodeMeetingsCursor,
  clampMeetingsLimit,
  MEETINGS_PAGE_DEFAULT_LIMIT,
  MEETINGS_PAGE_MAX_LIMIT,
  type MeetingsCursor,
  type ListMeetingsPageOptions,
  type MeetingsPage,
} from './meetings-page.js';

/** Error messages raised by add_recording_session_bytes(session_id uuid, delta bigint) RETURNS bigint. */
export const RECORDING_SESSION_BYTES_ERRORS = {
  invalidDelta: 'recording_session_bytes_invalid_delta', // SQLSTATE 22023
  notFound: 'recording_session_not_found', // P0002
  notUploading: 'recording_session_not_uploading', // 55000
  exceeded: 'recording_session_bytes_exceeded', // 22003
} as const;

/**
 * Atomically add `delta` (> 0) bytes to recording_sessions.bytes_received of a session in the current org;
 * returns the new total. Call inside withOrgContext. Throws with one of RECORDING_SESSION_BYTES_ERRORS.
 */
export async function addRecordingSessionBytes(
  tx: DatabaseTransaction,
  sessionId: string,
  delta: bigint,
): Promise<bigint> {
  const rows = await tx.$queryRaw<{ total: bigint }[]>`
    SELECT public.add_recording_session_bytes(${sessionId}::uuid, ${delta}::bigint) AS total`;
  const total = rows[0]?.total;
  if (total === undefined) throw new Error('add_recording_session_bytes returned no row');
  return total;
}
