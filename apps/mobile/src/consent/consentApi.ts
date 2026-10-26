/**
 * Recording consent (plan.md M3, R1 + R3). DEMO ONLY: the Backend consent API (`POST` consent record with
 * userId, meetingId, organizationId, timestamp) does not exist yet, so this keeps records in memory and
 * nothing leaves the device. The real client derives userId/organizationId from the session server-side.
 * TODO(contracts): replace the local types with @meetops/contracts once Architecture adds the consent schema.
 */
export interface ParticipantNoticeRecord {
  /** Client-generated id for this recording until meetings exist server-side. */
  meetingId: string;
  /** ISO-8601 time the user confirmed the notice. */
  confirmedAt: string;
}

export interface ConsentApi {
  /** R1: has the user explicitly opted in to recording on this device? */
  hasOptedIn: () => Promise<boolean>;
  /** R1: record the explicit opt-in. Never called implicitly. */
  optIn: () => Promise<void>;
  /** R3: log the per-recording participant notice confirmation. Must resolve before `start`. */
  confirmParticipantNotice: (record: ParticipantNoticeRecord) => Promise<void>;
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
    },
  };
}

let counter = 0;
/** Local recording id (not a secret, not security-relevant). */
export function newLocalMeetingId(now: number = Date.now()): string {
  counter += 1;
  return `local-${now.toString(36)}-${counter}`;
}
