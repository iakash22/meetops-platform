import type { ConsentAttestationInput, ConsentMethod } from '@meetops/contracts';
import { CURRENT_CONSENT_VERSION } from '@meetops/contracts/types';

/**
 * Recording consent (plan.md M3, R1 + R3), aligned with contracts v0.4.1 (G11): there is no standalone consent route.
 * The participant notice produces a `ConsentAttestationInput` that the upload queue attaches to
 * `InitRecordingSessionRequest.consent` / `InitUploadRequest.consent`; the server fills user and organization from the
 * session and stores it. The opt-in flag (R1) is device-local. The demo keeps records in memory.
 */
export interface ParticipantNoticeRecord {
  /** Client-generated id for this recording until meetings exist server-side. */
  meetingId: string;
  /** ISO-8601 time the user confirmed the notice. */
  confirmedAt: string;
  /** How consent was obtained. Defaults to `all_parties_notified`. */
  method?: ConsentMethod;
}

/** Builds the contracts attestation for a confirmed notice. */
export function toAttestation(record: ParticipantNoticeRecord): ConsentAttestationInput {
  return {
    consentVersion: CURRENT_CONSENT_VERSION,
    attestedAt: record.confirmedAt,
    method: record.method ?? 'all_parties_notified',
  };
}

export interface ConsentApi {
  /** R1: has the user explicitly opted in to recording on this device? */
  hasOptedIn: () => Promise<boolean>;
  /** R1: record the explicit opt-in. Never called implicitly. */
  optIn: () => Promise<void>;
  /**
   * R3: log the per-recording participant notice confirmation. Must resolve before `start`. Returns the attestation
   * the recording's upload must carry.
   */
  confirmParticipantNotice: (record: ParticipantNoticeRecord) => Promise<ConsentAttestationInput>;
}

export function createDemoConsentApi(
  options: { optedIn?: boolean; latencyMs?: number } = {},
): ConsentApi & { notices: ParticipantNoticeRecord[] } {
  let optedIn = options.optedIn ?? false;
  const notices: ParticipantNoticeRecord[] = [];
  const wait = () =>
    options.latencyMs
      ? new Promise<void>((r) => setTimeout(r, options.latencyMs))
      : Promise.resolve();
  return {
    notices,
    hasOptedIn: async () => optedIn,
    optIn: async () => {
      await wait();
      optedIn = true;
    },
    confirmParticipantNotice: async (record) => {
      await wait();
      if (!optedIn) throw new Error('Opt-in consent is required before a participant notice.');
      notices.push(record);
      return toAttestation(record);
    },
  };
}

let counter = 0;
/** Local recording id (not a secret, not security-relevant). */
export function newLocalMeetingId(now: number = Date.now()): string {
  counter += 1;
  return `local-${now.toString(36)}-${counter}`;
}
