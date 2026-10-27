/**
 * ADR-011 section 3: api -> realtime revocation messages on Redis pub/sub. Identifiers only: never a token,
 * cookie or token hash. Mirrors @meetops/contracts AuthRevocationMessage (ARC-2, v0.4.1); switch these local
 * types to the contracts schema once v0.4.1 is on integration.
 */
export const AUTH_REVOCATIONS_CHANNEL = 'meetops:auth:revocations';
export const AUTH_REVOCATION_MESSAGE_VERSION = 1;
export const AUTH_REVOCATION_REASONS = [
  'logout',
  'logout_all',
  'org_switch',
  'member_removed',
  'role_changed',
  'invitation_revoked',
  'password_changed',
  'extension_revoked',
] as const;
export type AuthRevocationReason = (typeof AUTH_REVOCATION_REASONS)[number];

interface Base {
  v: typeof AUTH_REVOCATION_MESSAGE_VERSION;
  userId: string;
  reason: AuthRevocationReason;
  /** ISO 8601. */
  at: string;
}
/** `session`: one session (or extension token family). `user`: every session of userId. `membership`: userId in organizationId. */
export type AuthRevocationMessage =
  | (Base & { kind: 'session'; sessionId: string; organizationId?: string })
  | (Base & { kind: 'user' })
  | (Base & { kind: 'membership'; organizationId: string });

/** What a caller supplies; `v` and `at` are filled in. */
export type AuthRevocationInput =
  | {
      kind: 'session';
      sessionId: string;
      userId: string;
      organizationId?: string | null;
      reason: AuthRevocationReason;
    }
  | { kind: 'user'; userId: string; reason: AuthRevocationReason }
  | { kind: 'membership'; userId: string; organizationId: string; reason: AuthRevocationReason };

export function buildRevocationMessage(
  input: AuthRevocationInput,
  at: Date,
): AuthRevocationMessage {
  const base = {
    v: AUTH_REVOCATION_MESSAGE_VERSION,
    userId: input.userId,
    reason: input.reason,
    at: at.toISOString(),
  } as const;
  switch (input.kind) {
    case 'session':
      return {
        ...base,
        kind: 'session',
        sessionId: input.sessionId,
        ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      };
    case 'user':
      return { ...base, kind: 'user' };
    case 'membership':
      return { ...base, kind: 'membership', organizationId: input.organizationId };
  }
}

/** The one Redis command used (ioredis and node-redis both match). */
export interface RedisPublisher {
  publish(channel: string, message: string): Promise<unknown>;
}

export interface RevocationPublisher {
  publish(input: AuthRevocationInput): Promise<void>;
}

/** Publishes to AUTH_REVOCATIONS_CHANNEL. Call only after the change has committed. */
export function createRedisRevocationPublisher(
  redis: RedisPublisher,
  clock: { now(): Date } = { now: () => new Date() },
): RevocationPublisher {
  return {
    async publish(input) {
      await redis.publish(
        AUTH_REVOCATIONS_CHANNEL,
        JSON.stringify(buildRevocationMessage(input, clock.now())),
      );
    },
  };
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const isStr = (v: unknown): v is string => typeof v === 'string';
const KEYS: Record<AuthRevocationMessage['kind'], { required: string[]; optional: string[] }> = {
  session: {
    required: ['v', 'kind', 'userId', 'reason', 'at', 'sessionId'],
    optional: ['organizationId'],
  },
  user: { required: ['v', 'kind', 'userId', 'reason', 'at'], optional: [] },
  membership: { required: ['v', 'kind', 'userId', 'reason', 'at', 'organizationId'], optional: [] },
};

/** Strict parse for subscribers. Anything else (extra keys, bad ids, unknown reason) is null: drop and count it. */
export function parseRevocationMessage(raw: string): AuthRevocationMessage | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return null;
  const o = m as Record<string, unknown>;
  const kind = o.kind;
  if (kind !== 'session' && kind !== 'user' && kind !== 'membership') return null;
  const spec = KEYS[kind];
  const keys = Object.keys(o);
  if (!spec.required.every((k) => k in o)) return null;
  if (!keys.every((k) => spec.required.includes(k) || spec.optional.includes(k))) return null;
  if (o.v !== AUTH_REVOCATION_MESSAGE_VERSION) return null;
  if (!isStr(o.reason) || !(AUTH_REVOCATION_REASONS as readonly string[]).includes(o.reason))
    return null;
  if (!isStr(o.at) || Number.isNaN(Date.parse(o.at))) return null;
  for (const k of ['userId', 'sessionId', 'organizationId'] as const) {
    if (k in o && !(isStr(o[k]) && ID.test(o[k]))) return null;
  }
  return o as unknown as AuthRevocationMessage;
}
