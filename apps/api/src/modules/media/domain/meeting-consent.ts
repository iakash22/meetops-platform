import {
  CURRENT_CONSENT_VERSION,
  type ConsentMethod,
  type MeetingConsentEventType,
  type MeetingConsentState,
} from '@meetops/contracts';
import { ConsentRejectedError } from './consent.js';

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

/** Derived state: the latest event wins, so a revocation supersedes every earlier grant. */
export function consentState(latest: MeetingConsentEventRecord | null): {
  state: MeetingConsentState;
  valid: boolean;
} {
  if (!latest) return { state: 'none', valid: false };
  return {
    state: latest.eventType,
    valid: latest.eventType === 'granted' && latest.consentVersion === CURRENT_CONSENT_VERSION,
  };
}

/** What enforcement needs: the ledger (optional, missing = fail closed) and the CONSENT_ENFORCEMENT_ENABLED flag. */
export interface MeetingConsentGate {
  meetingConsents?: MeetingConsentRepository | undefined;
  consentEnforcement?: boolean | undefined;
}

/**
 * CONSENT_ENFORCEMENT_ENABLED: media capture/upload for a meeting requires the meeting's latest consent event to be a
 * grant for CURRENT_CONSENT_VERSION. Fails closed: no meeting, no ledger wired, no event, a revocation or an old
 * version all reject with 422. A no-op while the flag is off (default), so existing clients keep working.
 */
export async function enforceMeetingConsent(
  g: MeetingConsentGate,
  organizationId: string,
  meetingId: string | null | undefined,
): Promise<void> {
  if (g.consentEnforcement !== true) return;
  if (!meetingId || !g.meetingConsents) throw new ConsentRejectedError('CONSENT_REQUIRED');
  const [latest] = await g.meetingConsents.list(organizationId, meetingId, 1);
  if (!latest || latest.eventType !== 'granted') throw new ConsentRejectedError('CONSENT_REQUIRED');
  if (latest.consentVersion !== CURRENT_CONSENT_VERSION) {
    throw new ConsentRejectedError('CONSENT_VERSION_UNSUPPORTED');
  }
}
