import {
  type ConsentMethod,
  type MeetingConsentEventType,
  type MeetingConsentState,
} from '@meetops/contracts';
import { ConsentRejectedError, type ConsentVersionResolver } from './consent.js';

/** A stored meeting_consent_events row (append-only ledger), as the API sees it. */
export interface MeetingConsentEventRecord {
  id: string;
  organizationId: string;
  meetingId: string;
  eventType: MeetingConsentEventType;
  consentVersion: string | null;
  method: ConsentMethod | null;
  reason: string | null;
  actorUserId: string;
  occurredAt: Date;
  recordedAt: Date;
}

export type NewMeetingConsentEvent = Omit<MeetingConsentEventRecord, 'id'>;

/** Append-only (the DB grants SELECT, INSERT only). Every call is scoped to one organization. */
export interface MeetingConsentRepository {
  append(e: NewMeetingConsentEvent): Promise<MeetingConsentEventRecord>;
  /** Newest first by DB insertion order (meeting_consent_events.seq desc, not the app clock), at most `limit`. */
  list(
    organizationId: string,
    meetingId: string,
    limit: number,
  ): Promise<MeetingConsentEventRecord[]>;
}

/**
 * Derived state: the latest event wins, so a revocation supersedes every earlier grant. `acceptedVersion` is the org's
 * current consent version (ConsentVersionResolver).
 */
export function consentState(
  latest: MeetingConsentEventRecord | null,
  acceptedVersion: string,
): {
  state: MeetingConsentState;
  valid: boolean;
} {
  if (!latest) return { state: 'none', valid: false };
  return {
    state: latest.eventType,
    valid: latest.eventType === 'granted' && latest.consentVersion === acceptedVersion,
  };
}

/**
 * What enforcement needs: the ledger (optional, missing = fail closed), the CONSENT_ENFORCEMENT_ENABLED flag and the
 * org's current consent version.
 */
export interface MeetingConsentGate {
  meetingConsents?: MeetingConsentRepository | undefined;
  consentEnforcement?: boolean | undefined;
  consentVersion: ConsentVersionResolver;
}

/**
 * CONSENT_ENFORCEMENT_ENABLED: media capture/upload for a meeting requires the meeting's latest consent event to be a
 * grant for the org's current consent version (its stored settings, else CURRENT_CONSENT_VERSION). Fails closed: no meeting, no ledger wired, no event, a revocation or an old
 * version all reject with 422. A no-op while the flag is off (default), so existing clients keep working.
 */
export async function enforceMeetingConsent(
  g: MeetingConsentGate,
  organizationId: string,
  meetingId: string | null | undefined,
  /**
   * 'current' (new capture: init) requires a grant for the org's current version. 'in_flight' (chunk URLs, complete,
   * replay of an already-started subject) accepts the latest grant whatever its version, since that version was
   * checked when the grant was recorded; a revocation still rejects.
   */
  version: 'current' | 'in_flight' = 'current',
): Promise<void> {
  if (g.consentEnforcement !== true) return;
  if (!meetingId || !g.meetingConsents) throw new ConsentRejectedError('CONSENT_REQUIRED');
  const [latest] = await g.meetingConsents.list(organizationId, meetingId, 1);
  if (!latest || latest.eventType !== 'granted') throw new ConsentRejectedError('CONSENT_REQUIRED');
  if (version === 'current' && latest.consentVersion !== (await g.consentVersion(organizationId))) {
    throw new ConsentRejectedError('CONSENT_VERSION_UNSUPPORTED');
  }
}
