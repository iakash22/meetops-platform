import type { OrganizationService } from '../../organizations/application/organization.service.js';
import type { DirectoryAccess, DirectoryCaller } from '../../directory/access.js';
import {
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

export const DEFAULT_MEETING_TITLE = 'Untitled meeting';

/** Meetings use cases. Order on every call: tenant (404) -> CASL (403) -> repository. */
export class MeetingService {
  constructor(
    private readonly meetings: MeetingRepository,
    private readonly access: DirectoryAccess,
    private readonly orgs: Pick<OrganizationService, 'authorize'>,
  ) {}

  list(
    c: DirectoryCaller,
    q: { cursor?: string | undefined; limit: number },
  ): Promise<MeetingPage> {
    this.orgs.authorize(c.ctx, 'read', 'Meeting');
    return this.meetings.list(c.ctx.organizationId, q);
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
