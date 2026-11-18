/**
 * Durable retries of account-takeover follow-ups (#459 NB-R3-2, #463 review). After a mailbox-owner takeover has
 * committed, the revocations that still failed in-request are handed to a queue so a restart or deploy cannot drop
 * them. Jobs carry the user id and the follow-up kind only: never emails, tokens or secrets.
 */
export const TAKEOVER_FOLLOW_UP_KINDS = ['realtime', 'extension_tokens', 'push_devices'] as const;

export type TakeoverFollowUpKind = (typeof TAKEOVER_FOLLOW_UP_KINDS)[number];

export interface TakeoverFollowUpJob {
  userId: string;
  kind: TakeoverFollowUpKind;
}

export const isTakeoverFollowUpKind = (v: unknown): v is TakeoverFollowUpKind =>
  typeof v === 'string' && (TAKEOVER_FOLLOW_UP_KINDS as readonly string[]).includes(v);

/** Producer port. `enqueue` rejects when the job could not be stored, so the caller can fall back. */
export interface TakeoverFollowUpQueue {
  enqueue(job: TakeoverFollowUpJob): Promise<void>;
}

/** Runs one follow-up. Every kind is idempotent: running it twice is safe. */
export interface TakeoverFollowUpRunner {
  runTakeoverFollowUp(job: TakeoverFollowUpJob): Promise<void>;
}
