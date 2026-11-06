import { MAX_ANALYTICS_RANGE_DAYS } from '@meetops/contracts';
import type { OrganizationService } from '../../organizations/application/organization.service.js';
import type { RateLimiter } from '../../auth/domain/ports.js';
import { RateLimitedError } from '../../auth/domain/errors.js';
import type { DirectoryAccess, DirectoryCaller } from '../../directory/access.js';
import {
  parseAnalyticsRange,
  type AnalyticsBucket,
  type MeetingAnalyticsResult,
  deriveExternalMeetingId,
  isUuid,
  MeetingNotFoundError,
  type MeetingPage,
  type MeetingRecord,
  type MeetingRepository,
  type MeetingSource,
} from '../domain/meeting.js';

export interface ResolveMeetingInput {
  source: MeetingSource;
  title?: string | undefined;
  startedAt?: string | undefined;
  externalMeetingId?: string | undefined;
  externalMeetingUrl?: string | undefined;
}

/** L-3: per caller and per organization fixed windows on POST /orgs/:org/meetings/resolve. */
export const RESOLVE_LIMITS = {
  perUser: { limit: 30, windowMs: 60_000 },
  perOrg: { limit: 300, windowMs: 60_000 },
} as const;

/** Per caller and per organization fixed windows on POST /orgs/:org/meetings (same budget as resolve). */
export const CREATE_LIMITS = {
  perUser: { limit: 30, windowMs: 60_000 },
  perOrg: { limit: 300, windowMs: 60_000 },
} as const;

export interface CreateMeetingInput {
  title: string;
  startedAt?: string | undefined;
  projectId?: string | undefined;
}

export const DEFAULT_MEETING_TITLE = 'Untitled meeting';

/** Meetings use cases. Order on every call: tenant (404) -> CASL (403) -> repository. */
export class MeetingService {
  constructor(
    private readonly meetings: MeetingRepository,
    private readonly access: DirectoryAccess,
    private readonly orgs: Pick<OrganizationService, 'authorize'>,
    private readonly rateLimiter?: RateLimiter,
  ) {}

  private async limit(key: string, l: { limit: number; windowMs: number }) {
    if (!this.rateLimiter) return;
    const r = await this.rateLimiter.consume(key, l.limit, l.windowMs);
    if (!r.allowed) throw new RateLimitedError(r.retryAfterMs);
  }

  list(
    c: DirectoryCaller,
    q: { cursor?: string | undefined; limit: number; source?: MeetingSource | undefined },
  ): Promise<MeetingPage> {
    this.orgs.authorize(c.ctx, 'read', 'Meeting');
    return this.meetings.list(c.ctx.organizationId, q);
  }

  /**
   * Read-only org analytics (viewer and up: CASL read Meeting). Range is half-open [from, to), to > from, at most
   * MAX_ANALYTICS_RANGE_DAYS; checked after the tenant and CASL gates so an outsider learns nothing.
   */
  async analytics(
    c: DirectoryCaller,
    q: { from: string; to: string; bucket?: AnalyticsBucket | undefined },
  ): Promise<{ from: Date; to: Date; bucket: AnalyticsBucket } & MeetingAnalyticsResult> {
    this.orgs.authorize(c.ctx, 'read', 'Meeting');
    const { from, to } = parseAnalyticsRange(q, MAX_ANALYTICS_RANGE_DAYS);
    const bucket = q.bucket ?? 'day';
    const r = await this.meetings.analytics(c.ctx.organizationId, { from, to, bucket });
    return { from, to, bucket, ...r };
  }

  async get(c: DirectoryCaller, id: string): Promise<MeetingRecord> {
    this.orgs.authorize(c.ctx, 'read', 'Meeting');
    const m = isUuid(id) ? await this.meetings.findById(c.ctx.organizationId, id) : null;
    if (!m) throw new MeetingNotFoundError();
    return m;
  }

  /** Idempotent per (organizationId, source, externalMeetingId). */
  async resolve(
    c: DirectoryCaller,
    input: ResolveMeetingInput,
  ): Promise<{ meeting: MeetingRecord; created: boolean }> {
    this.orgs.authorize(c.ctx, 'create', 'Meeting');
    const org = c.ctx.organizationId;
    await this.limit(`meetings:resolve:user:${org}:${c.ctx.userId}`, RESOLVE_LIMITS.perUser);
    await this.limit(`meetings:resolve:org:${org}`, RESOLVE_LIMITS.perOrg);
    const externalMeetingId =
      input.externalMeetingId ?? deriveExternalMeetingId(input.externalMeetingUrl ?? '');
    const out = await this.meetings.resolve(c.ctx.organizationId, {
      title: input.title ?? DEFAULT_MEETING_TITLE,
      source: input.source,
      externalMeetingId,
      startedAt: input.startedAt ? new Date(input.startedAt) : null,
      createdById: c.ctx.userId,
    });
    if (out.created) {
      await this.access.record(c, {
        action: 'meeting.create',
        targetType: 'meeting',
        targetId: out.meeting.id,
        metadata: { source: out.meeting.source },
      });
    }
    return out;
  }

  /** Manual create from the web "New meeting" dialog: source `upload`, status `scheduled`, audited. */
  async create(c: DirectoryCaller, input: CreateMeetingInput): Promise<MeetingRecord> {
    this.orgs.authorize(c.ctx, 'create', 'Meeting');
    const org = c.ctx.organizationId;
    await this.limit(`meetings:create:user:${org}:${c.ctx.userId}`, CREATE_LIMITS.perUser);
    await this.limit(`meetings:create:org:${org}`, CREATE_LIMITS.perOrg);
    const meeting = await this.meetings.create(org, {
      title: input.title.trim(),
      source: 'upload',
      startedAt: input.startedAt ? new Date(input.startedAt) : null,
      projectId: input.projectId ?? null,
      createdById: c.ctx.userId,
    });
    await this.access.record(c, {
      action: 'meeting.create',
      targetType: 'meeting',
      targetId: meeting.id,
      metadata: { source: meeting.source },
    });
    return meeting;
  }
}
