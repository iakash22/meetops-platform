/**
 * Durable retries of account-takeover follow-ups (#459 NB-R3-2, #463 review). After a mailbox-owner takeover has
 * committed, the revocations (and the set-password mail, if enqueueing it failed) that still failed in-request are
 * handed to a queue so a restart or deploy cannot drop them. Jobs carry the user id and the follow-up kind only:
 * never emails, tokens or secrets.
 */
export const TAKEOVER_FOLLOW_UP_KINDS = [
  'realtime',
  'extension_tokens',
  'push_devices',
  'set_password_mail',
] as const;

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

const SAFE_ERROR_NAME_RE = /^[\w.-]{1,64}$/;

/**
 * Safe error class/name (or typeof) for DLQ `errorType` and logs: never a message. Shared by the takeover queue and
 * AuthService so both log the same shape.
 */
export function safeErrorType(err: unknown): string {
  if (err instanceof Error && SAFE_ERROR_NAME_RE.test(err.name)) return err.name;
  return err instanceof Error ? 'Error' : typeof err;
}

/** Error class and a safe code only: never a message, email, token or user name. */
export function safeErrorSummary(err: unknown): { type: string; code?: string } {
  const type = safeErrorType(err);
  if (!(err instanceof Error)) return { type };
  const code = (err as { code?: unknown }).code;
  return { type, ...(typeof code === 'string' && SAFE_ERROR_NAME_RE.test(code) ? { code } : {}) };
}
