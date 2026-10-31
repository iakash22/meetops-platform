import { describe, it, expect, expectTypeOf } from 'vitest';
import * as C from '../src/index.js';
import type {
  ApiErrorCode,
  ApiErrorEnvelope,
  CsrfResponse,
  CursorPage,
  ForgotPasswordRequest,
  GetAuthSession,
  GetAuthSessionResponse,
  Id,
  IsoDateTime,
  LoginRequest,
  Membership,
  MeetingSource,
  Organization,
  Paginated,
  Role,
  SignupRequest,
  TaskPriority,
  TaskStatus,
  User,
} from '../src/index.js';

describe('main barrel', () => {
  it.each([
    'ApiErrorEnvelope',
    'ApiErrorCode',
    'Paginated',
    'CursorPage',
    'Organization',
    'User',
    'Membership',
    'Role',
    'LoginRequest',
    'SignupRequest',
    'ForgotPasswordRequest',
    'ResetPasswordRequest',
    'VerifyEmailRequest',
    'Id',
    'IsoDateTime',
    'GetAuthSessionResponse',
    'GetAuthSession',
    'CsrfResponse',
    'MeetingSource',
    'TaskStatus',
    'TaskPriority',
    'MeetingParticipant',
    'ReportContent',
    'InitRecordingSessionRequest',
    // v0.4.0 directory
    'EmployeeDto',
    'CreateEmployeeRequest',
    'UpdateEmployeeRequest',
    'ListEmployeesQuery',
    'ListEmployeesResponse',
    'EmployeeParams',
    'EmployeesParams',
    'TeamDto',
    'CreateTeamRequest',
    'UpdateTeamRequest',
    'ListTeamsQuery',
    'ListTeamsResponse',
    'TeamParams',
    'TeamsParams',
    'TeamMemberDto',
    'TeamMemberRole',
    'AddTeamMemberRequest',
    'UpdateTeamMemberRequest',
    'ListTeamMembersQuery',
    'ListTeamMembersResponse',
    'TeamMemberParams',
    'ProjectDto',
    'ProjectStatus',
    'CreateProjectRequest',
    'UpdateProjectRequest',
    'ListProjectsQuery',
    'ListProjectsResponse',
    'ProjectParams',
    'ProjectsParams',
    'NotFoundReason',
    'ApiErrorReason',
    'DIRECTORY_PATHS',
    'NOT_FOUND_REASONS',
    'DIRECTORY_ERROR_REASONS',
    'PROJECT_STATUSES',
    'TEAM_MEMBER_ROLES',
    'SafeMultilineText',
    // v0.4.1
    'ConsentMethod',
    'ConsentVersion',
    'ConsentSubjectType',
    'ConsentErrorReason',
    'ConsentAttestationInput',
    'ConsentAttestation',
    'InitUploadRequest',
    'InitUploadResponse',
    'FileObjectScanStatus',
    'AuthRevocationMessage',
    'AuthRevocationReason',
    'AuthRevocationKind',
    'SessionRevokedEvent',
    'OrgAccessChangedEvent',
    'OrgAccessChangeReason',
    'AuthReauthRequiredEvent',
    'ReauthReason',
    'RealtimeControlEvent',
    'RealtimeControlEventSchemas',
    'CONSENT_METHODS',
    'CURRENT_CONSENT_VERSION',
    'FILE_OBJECT_SCAN_STATUSES',
    'AUTH_REVOCATIONS_CHANNEL',
    'REALTIME_CONTROL_EVENTS',
    'MAX_PRESIGNED_GET_TTL_SECONDS',
  ])('exports schema %s', (name) => {
    expect(C).toHaveProperty(name);
    expect((C as Record<string, unknown>)[name]).toBeDefined();
  });
  it('GetAuthSession is an alias of GetAuthSessionResponse', () => {
    expect(C.GetAuthSession).toBe(C.GetAuthSessionResponse);
  });
  it('exports matching Static types', () => {
    expectTypeOf<Id>().toEqualTypeOf<string>();
    expectTypeOf<IsoDateTime>().toEqualTypeOf<string>();
    expectTypeOf<Role>().toEqualTypeOf<'owner' | 'admin' | 'member' | 'viewer'>();
    expectTypeOf<TaskStatus>().toEqualTypeOf<'todo' | 'in_progress' | 'done' | 'cancelled'>();
    expectTypeOf<TaskPriority>().toEqualTypeOf<'low' | 'medium' | 'high' | 'urgent'>();
    expectTypeOf<MeetingSource>().toEqualTypeOf<
      'upload' | 'extension' | 'desktop' | 'bot' | 'mobile'
    >();
    expectTypeOf<ApiErrorCode>().toMatchTypeOf<string>();
    expectTypeOf<ApiErrorEnvelope['error']['requestId']>().toEqualTypeOf<string>();
    expectTypeOf<Paginated<User>>().toEqualTypeOf<CursorPage<User>>();
    expectTypeOf<Organization>().toHaveProperty('slug');
    expectTypeOf<Membership>().toHaveProperty('role');
    expectTypeOf<LoginRequest>().toEqualTypeOf<{ email: string; password: string }>();
    expectTypeOf<SignupRequest>().toHaveProperty('name');
    expectTypeOf<ForgotPasswordRequest>().toEqualTypeOf<{ email: string }>();
    expectTypeOf<CsrfResponse>().toEqualTypeOf<{ csrfToken: string }>();
    expectTypeOf<GetAuthSession>().toEqualTypeOf<GetAuthSessionResponse>();
    expectTypeOf<GetAuthSessionResponse>().not.toHaveProperty('csrfToken');
  });
});
