import {
  MAX_MEETING_CONSENT_EVENTS,
  type MeetingConsentStatus,
  type RevokeMeetingConsentRequest,
} from '@meetops/contracts';
import type { DirectoryCaller } from '../../directory/access.js';
import { MeetingNotFoundError, type MeetingRepository } from '../../meetings/domain/meeting.js';
import { checkConsentInput, type ConsentVersionResolver } from '../domain/consent.js';
import {
  consentState,
  type MeetingConsentEventRecord,
  type MeetingConsentRepository,
} from '../domain/meeting-consent.js';
import { authorizeMedia } from './media-access.js';

const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export interface MeetingConsentDeps {
  meetingConsents: MeetingConsentRepository;
  meetings: MeetingRepository;
  now: () => Date;
  /** The org's current consent version (stored settings, else CURRENT_CONSENT_VERSION), read server-side. */
  consentVersion: ConsentVersionResolver;
}

/**
 * Consent API. Order: tenant + meeting (404) -> CASL (403) -> consent body (422) -> append. The org and the actor come
 * from the caller (session or bearer), never from the body. Writes need RecordingSession `create` (owner/admin/member,
 * not viewer); reads are open to every role of the org.
 */
export class MeetingConsentService {
  constructor(private readonly d: MeetingConsentDeps) {}

  private async meeting(c: DirectoryCaller, meetingId: string): Promise<string> {
    const org = c.ctx.organizationId;
    const m = isUuid(meetingId) ? await this.d.meetings.findById(org, meetingId) : null;
    if (!m) throw new MeetingNotFoundError();
    return org;
  }

  async record(c: DirectoryCaller, meetingId: string, body: unknown) {
    const org = await this.meeting(c, meetingId);
    authorizeMedia(c, 'create', 'RecordingSession');
    const now = this.d.now();
    const input = checkConsentInput(body, now, await this.d.consentVersion(org));
    return this.d.meetingConsents.append({
      organizationId: org,
      meetingId,
      eventType: 'granted',
      consentVersion: input.consentVersion,
      method: input.method,
      reason: null,
      actorUserId: c.ctx.userId,
      occurredAt: new Date(input.attestedAt),
      recordedAt: now,
    });
  }

  async revoke(c: DirectoryCaller, meetingId: string, body: RevokeMeetingConsentRequest) {
    const org = await this.meeting(c, meetingId);
    authorizeMedia(c, 'create', 'RecordingSession');
    const now = this.d.now();
    return this.d.meetingConsents.append({
      organizationId: org,
      meetingId,
      eventType: 'revoked',
      consentVersion: null,
      method: null,
      reason: body.reason ?? null,
      actorUserId: c.ctx.userId,
      occurredAt: now,
      recordedAt: now,
    });
  }

  async status(c: DirectoryCaller, meetingId: string): Promise<MeetingConsentStatus> {
    const org = await this.meeting(c, meetingId);
    const events = await this.d.meetingConsents.list(org, meetingId, MAX_MEETING_CONSENT_EVENTS);
    const latest = events[0] ?? null;
    return {
      meetingId,
      ...consentState(latest, await this.d.consentVersion(org)),
      latest: latest ? toWire(latest) : null,
      events: events.map(toWire),
    };
  }
}

export const toWire = (e: MeetingConsentEventRecord) => ({
  id: e.id,
  meetingId: e.meetingId,
  eventType: e.eventType,
  consentVersion: e.consentVersion,
  method: e.method,
  reason: e.reason,
  actorUserId: e.actorUserId,
  occurredAt: e.occurredAt.toISOString(),
  recordedAt: e.recordedAt.toISOString(),
});
