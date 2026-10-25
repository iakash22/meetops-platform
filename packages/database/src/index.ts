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
  MediaPersistenceError,
  MAX_RECORDING_CHUNKS,
  type ChunkFileObjectRow,
  type ChunkFileObjectRepository,
  type ChunkFileObjectRepositoryOptions,
  type RecordingChunkCountRepository,
  type ChunkFileObjectRecord,
  type ChunkFileObjectLookup,
  type MediaRepositoryOptions,
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
