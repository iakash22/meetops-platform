import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Replay window. GitHub deliveries carry NO signed timestamp, so the delivery-id TTL is the only replay control:
 * a captured signed request can be replayed once its id expires. GitHub lets admins redeliver for up to 3 days, so
 * we keep ids for 7 days and never allow a shorter window.
 */
export const MIN_REPLAY_TTL_SECONDS = 604_800;
export const DEFAULT_REPLAY_TTL_SECONDS = MIN_REPLAY_TTL_SECONDS;

/** Clamp a configured TTL to [7 days, ∞). Non-finite / missing values fall back to the default. */
export function effectiveReplayTtlSeconds(ttlSeconds?: number): number {
  if (ttlSeconds === undefined || !Number.isFinite(ttlSeconds)) return DEFAULT_REPLAY_TTL_SECONDS;
  return Math.max(MIN_REPLAY_TTL_SECONDS, Math.ceil(ttlSeconds));
}

/** Upper bound on delivery-id length; anything longer is rejected before touching the store. */
export const MAX_DELIVERY_ID_LENGTH = 64;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** X-GitHub-Delivery is a GUID. Rejects anything else (prevents key-space abuse / injection into store keys). */
export function isValidGitHubDeliveryId(id: string | undefined): id is string {
  return typeof id === 'string' && id.length <= MAX_DELIVERY_ID_LENGTH && GUID_RE.test(id);
}

export interface FreshnessOptions {
  /** Maximum accepted age of the event. */
  maxAgeSeconds: number;
  /** Allowed clock skew into the future. Default 300s. */
  maxFutureSkewSeconds?: number;
  now?: () => number;
}

export type FreshnessResult = 'fresh' | 'stale' | 'future' | 'invalid';

/**
 * Freshness check for providers that send an event timestamp (epoch ms or s, or ISO-8601).
 * Only meaningful as a replay control when the timestamp is covered by the signature (e.g. inside a signed body).
 */
export function checkTimestampFreshness(timestamp: unknown, opts: FreshnessOptions): FreshnessResult {
  let ms: number;
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) ms = timestamp < 1e12 ? timestamp * 1000 : timestamp;
  else if (typeof timestamp === 'string' && /^\d{10,13}$/.test(timestamp)) ms = timestamp.length <= 10 ? Number(timestamp) * 1000 : Number(timestamp);
  else if (typeof timestamp === 'string' && timestamp.length <= 40 && !Number.isNaN(Date.parse(timestamp))) ms = Date.parse(timestamp);
  else return 'invalid';
  if (!(opts.maxAgeSeconds > 0)) return 'invalid';
  const now = (opts.now ?? Date.now)();
  if (ms - now > (opts.maxFutureSkewSeconds ?? 300) * 1000) return 'future';
  if (now - ms > opts.maxAgeSeconds * 1000) return 'stale';
  return 'fresh';
}

/**
 * Jira Cloud webhook bodies include `timestamp` (epoch ms). Use after verifying the request's authenticity
 * (shared secret / JWT). If the field is absent: `requireTimestamp` (default false) decides; absent -> 'invalid'.
 */
export function checkJiraWebhookFreshness(payload: unknown, opts: FreshnessOptions & { requireTimestamp?: boolean }): FreshnessResult | 'absent' {
  const ts = (payload as { timestamp?: unknown } | null)?.timestamp;
  if (ts === undefined || ts === null) return opts.requireTimestamp ? 'invalid' : 'absent';
  return checkTimestampFreshness(ts, opts);
}

/** Store of seen webhook delivery ids for replay protection. Implement with Redis (SET NX EX) in production. */
export interface DeliveryStore {
  /**
   * Atomically record a delivery id. Returns true if newly recorded, false if it was already seen.
   * Entries should expire after ttlSeconds.
   */
  markIfNew(deliveryId: string, ttlSeconds: number): Promise<boolean>;
}

/** In-memory TTL store. Single-process only; use a shared store (Redis) with multiple replicas. */
export interface InMemoryDeliveryStoreOptions {
  now?: () => number;
  maxEntries?: number;
  /** Defaults to process.env.NODE_ENV. */
  nodeEnv?: string | undefined;
  /** Explicit escape hatch for tests only; production must use a shared (Redis) store. */
  unsafeAllowInProduction?: boolean;
}

export class InMemoryDeliveryStore implements DeliveryStore {
  private readonly seen = new Map<string, number>();
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(options: InMemoryDeliveryStoreOptions = {}) {
    const env = 'nodeEnv' in options ? options.nodeEnv : process.env.NODE_ENV;
    if (env === 'production' && options.unsafeAllowInProduction !== true) {
      throw new Error('InMemoryDeliveryStore is not allowed in production; use a Redis-backed DeliveryStore');
    }
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? 10_000;
  }

  async markIfNew(deliveryId: string, ttlSeconds: number): Promise<boolean> {
    const t = this.now();
    this.prune(t);
    const exp = this.seen.get(deliveryId);
    if (exp !== undefined && exp > t) return false;
    this.seen.set(deliveryId, t + effectiveReplayTtlSeconds(ttlSeconds) * 1000);
    while (this.seen.size > this.maxEntries) {
      const first = this.seen.keys().next().value;
      if (first === undefined) break;
      this.seen.delete(first);
    }
    return true;
  }

  get size(): number {
    return this.seen.size;
  }

  private prune(t: number) {
    for (const [k, exp] of this.seen) if (exp <= t) this.seen.delete(k);
  }
}

export type WebhookFailureReason =
  | 'missing_signature'
  | 'malformed_signature'
  | 'invalid_signature'
  | 'unknown_integration'
  | 'missing_delivery_id'
  | 'malformed_delivery_id'
  | 'replayed_delivery'
  | 'invalid_payload'
  | 'payload_too_large';

/** Identifiers GitHub sends that let us route to the right integration's secret. */
export interface WebhookRoutingRef {
  /** X-GitHub-Hook-ID */
  hookId?: string;
  /** X-GitHub-Hook-Installation-Target-ID (repo/org/app id the hook is installed on) */
  targetId?: string;
  /** X-GitHub-Hook-Installation-Target-Type */
  targetType?: string;
  /** payload.installation.id (GitHub App deliveries) — read from the unverified body for routing only. */
  installationId?: string;
}

export interface ResolvedWebhookSecret {
  organizationId: string;
  integrationId: string;
  secret: string;
}

/** Implemented by Backend: map routing ids -> per-integration secret (from secret manager). Null if unknown. */
export interface WebhookSecretResolver {
  resolve(ref: WebhookRoutingRef): Promise<ResolvedWebhookSecret | null>;
}

export type WebhookVerificationResult =
  | { ok: true; deliveryId: string; event: string | undefined; payload: unknown; organizationId: string; integrationId: string }
  | { ok: false; reason: WebhookFailureReason; status: 400 | 401 | 409 | 413 };

export class WebhookVerificationError extends Error {
  constructor(
    readonly reason: WebhookFailureReason,
    readonly status: number
  ) {
    super(`GitHub webhook verification failed: ${reason}`);
    this.name = 'WebhookVerificationError';
  }
}

export type HeaderBag = Record<string, string | string[] | undefined> | Headers;

function header(headers: HeaderBag, name: string): string | undefined {
  if (typeof Headers !== 'undefined' && headers instanceof Headers) return headers.get(name) ?? undefined;
  const bag = headers as Record<string, string | string[] | undefined>;
  const key = Object.keys(bag).find((k) => k.toLowerCase() === name.toLowerCase());
  const v = key ? bag[key] : undefined;
  return Array.isArray(v) ? v[0] : v;
}

/** Constant-time check of `sha256=<hex>` against HMAC-SHA256(secret, rawBody). A missing secret fails closed (invalid). */
export function verifyGitHubSignature(secret: string, rawBody: string | Uint8Array, signatureHeader: string | undefined): WebhookFailureReason | null {
  if (!signatureHeader) return 'missing_signature';
  const m = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader.trim());
  if (!m?.[1]) return 'malformed_signature';
  if (!secret) return 'invalid_signature';
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(m[1], 'hex');
  if (given.length !== expected.length) return 'invalid_signature';
  return timingSafeEqual(given, expected) ? null : 'invalid_signature';
}

export interface VerifyWebhookOptions {
  secretResolver: WebhookSecretResolver;
  /** Exact raw request bytes — NOT re-serialized JSON. */
  rawBody: string | Uint8Array;
  headers: HeaderBag;
  deliveryStore: DeliveryStore;
  /** Replay window; default and minimum 7 days (values below are raised to 604800s). */
  replayTtlSeconds?: number;
  /** Default 1 MiB (GitHub caps payloads at 25 MB; issues events are small). */
  maxBodyBytes?: number;
}

const STATUS: Record<WebhookFailureReason, 400 | 401 | 409 | 413> = {
  missing_signature: 401,
  malformed_signature: 401,
  invalid_signature: 401,
  unknown_integration: 401,
  missing_delivery_id: 400,
  malformed_delivery_id: 400,
  replayed_delivery: 409,
  invalid_payload: 400,
  payload_too_large: 413
};

function idString(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isSafeInteger(v)) return String(v);
  if (typeof v === 'string' && /^\d{1,20}$/.test(v)) return v;
  return undefined;
}

/**
 * 1) size cap, 2) parse JSON (routing only), 3) resolve per-integration secret, 4) verify signature,
 * 5) record delivery id (only after a valid signature), then return the trusted payload + tenant ids.
 */
export async function verifyGitHubWebhook(opts: VerifyWebhookOptions): Promise<WebhookVerificationResult> {
  const fail = (reason: WebhookFailureReason) => ({ ok: false as const, reason, status: STATUS[reason] });
  const size = typeof opts.rawBody === 'string' ? Buffer.byteLength(opts.rawBody) : opts.rawBody.byteLength;
  if (size > (opts.maxBodyBytes ?? 1024 * 1024)) return fail('payload_too_large');
  const signature = header(opts.headers, 'x-hub-signature-256');
  if (!signature) return fail('missing_signature');
  let payload: unknown;
  try {
    const text = typeof opts.rawBody === 'string' ? opts.rawBody : Buffer.from(opts.rawBody).toString('utf8');
    payload = JSON.parse(text);
  } catch {
    return fail('invalid_payload');
  }
  const ref: WebhookRoutingRef = {};
  const hookId = idString(header(opts.headers, 'x-github-hook-id'));
  const targetId = idString(header(opts.headers, 'x-github-hook-installation-target-id'));
  const targetType = header(opts.headers, 'x-github-hook-installation-target-type');
  const installationId = idString((payload as { installation?: { id?: unknown } } | null)?.installation?.id);
  if (hookId) ref.hookId = hookId;
  if (targetId) ref.targetId = targetId;
  if (targetType && /^[a-z_]{1,32}$/.test(targetType)) ref.targetType = targetType;
  if (installationId) ref.installationId = installationId;
  if (!hookId && !targetId && !installationId) return fail('unknown_integration');
  const resolved = await opts.secretResolver.resolve(ref);
  if (!resolved?.secret) return fail('unknown_integration');
  const sigErr = verifyGitHubSignature(resolved.secret, opts.rawBody, signature);
  if (sigErr) return fail(sigErr);
  const rawDelivery = header(opts.headers, 'x-github-delivery');
  if (!rawDelivery) return fail('missing_delivery_id');
  const deliveryId = rawDelivery.trim().toLowerCase();
  if (!isValidGitHubDeliveryId(deliveryId)) return fail('malformed_delivery_id');
  const fresh = await opts.deliveryStore.markIfNew(deliveryId, effectiveReplayTtlSeconds(opts.replayTtlSeconds));
  if (!fresh) return fail('replayed_delivery');
  return {
    ok: true,
    deliveryId,
    event: header(opts.headers, 'x-github-event'),
    payload,
    organizationId: resolved.organizationId,
    integrationId: resolved.integrationId
  };
}

/** Throwing variant for frameworks that prefer exceptions. */
export async function assertGitHubWebhook(opts: VerifyWebhookOptions) {
  const r = await verifyGitHubWebhook(opts);
  if (!r.ok) throw new WebhookVerificationError(r.reason, r.status);
  return r;
}
