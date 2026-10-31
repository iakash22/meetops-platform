import { MAX_ANALYTICS_RANGE_DAYS } from '@meetops/contracts';
import type { OrganizationService } from '../../organizations/application/organization.service.js';
import type { RateLimiter } from '../../auth/domain/ports.js';
import { RateLimitedError } from '../../auth/domain/errors.js';
import type { DirectoryAccess, DirectoryCaller } from '../../directory/access.js';
import {
  InvalidAnalyticsRangeError,
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
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()))
      throw new InvalidAnalyticsRangeError('from and to must be ISO 8601 date-times');
    if (to <= from) throw new InvalidAnalyticsRangeError('to must be after from');
    if (to.getTime() - from.getTime() > MAX_ANALYTICS_RANGE_DAYS * 86_400_000)
      throw new InvalidAnalyticsRangeError(
        `The range may span at most ${MAX_ANALYTICS_RANGE_DAYS} days`,
      );
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
}
