import { createHmac, timingSafeEqual } from 'node:crypto';

/** Store of seen webhook delivery ids for replay protection. Implement with Redis (SET NX EX) in production. */
export interface DeliveryStore {
  /**
   * Atomically record a delivery id. Returns true if newly recorded, false if it was already seen.
   * Entries should expire after ttlSeconds.
   */
  markIfNew(deliveryId: string, ttlSeconds: number): Promise<boolean>;
}

/** In-memory TTL store. Single-process only; use a shared store (Redis) with multiple replicas. */
export class InMemoryDeliveryStore implements DeliveryStore {
  private readonly seen = new Map<string, number>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 10_000
  ) {}

  async markIfNew(deliveryId: string, ttlSeconds: number): Promise<boolean> {
    const t = this.now();
    this.prune(t);
    const exp = this.seen.get(deliveryId);
    if (exp !== undefined && exp > t) return false;
    this.seen.set(deliveryId, t + ttlSeconds * 1000);
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
  | 'missing_secret'
  | 'missing_signature'
  | 'malformed_signature'
  | 'invalid_signature'
  | 'missing_delivery_id'
  | 'replayed_delivery'
  | 'invalid_payload';

export type WebhookVerificationResult =
  | { ok: true; deliveryId: string; event: string | undefined; payload: unknown }
  | { ok: false; reason: WebhookFailureReason; status: 400 | 401 | 409 | 500 };

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

/** Constant-time check of `sha256=<hex>` against HMAC-SHA256(secret, rawBody). */
export function verifyGitHubSignature(secret: string, rawBody: string | Uint8Array, signatureHeader: string | undefined): WebhookFailureReason | null {
  if (!secret) return 'missing_secret';
  if (!signatureHeader) return 'missing_signature';
  const m = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader.trim());
  if (!m?.[1]) return 'malformed_signature';
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(m[1], 'hex');
  if (given.length !== expected.length) return 'invalid_signature';
  return timingSafeEqual(given, expected) ? null : 'invalid_signature';
}

export interface VerifyWebhookOptions {
  secret: string;
  /** Exact raw request bytes — NOT re-serialized JSON. */
  rawBody: string | Uint8Array;
  headers: HeaderBag;
  deliveryStore: DeliveryStore;
  /** Replay window; default 24h. */
  replayTtlSeconds?: number;
}

const STATUS: Record<WebhookFailureReason, 400 | 401 | 409 | 500> = {
  missing_secret: 500,
  missing_signature: 401,
  malformed_signature: 401,
  invalid_signature: 401,
  missing_delivery_id: 400,
  replayed_delivery: 409,
  invalid_payload: 400
};

/**
 * Verifies signature first, then records the delivery id (so unsigned requests can't poison the store),
 * then parses JSON. Never throws for verification failures; returns a typed result.
 */
export async function verifyGitHubWebhook(opts: VerifyWebhookOptions): Promise<WebhookVerificationResult> {
  const fail = (reason: WebhookFailureReason) => ({ ok: false as const, reason, status: STATUS[reason] });
  const sigErr = verifyGitHubSignature(opts.secret, opts.rawBody, header(opts.headers, 'x-hub-signature-256'));
  if (sigErr) return fail(sigErr);
  const deliveryId = header(opts.headers, 'x-github-delivery')?.trim();
  if (!deliveryId) return fail('missing_delivery_id');
  let payload: unknown;
  try {
    const text = typeof opts.rawBody === 'string' ? opts.rawBody : Buffer.from(opts.rawBody).toString('utf8');
    payload = JSON.parse(text);
  } catch {
    return fail('invalid_payload');
  }
  const fresh = await opts.deliveryStore.markIfNew(deliveryId, opts.replayTtlSeconds ?? 24 * 3600);
  if (!fresh) return fail('replayed_delivery');
  return { ok: true, deliveryId, event: header(opts.headers, 'x-github-event'), payload };
}

/** Throwing variant for frameworks that prefer exceptions. */
export async function assertGitHubWebhook(opts: VerifyWebhookOptions) {
  const r = await verifyGitHubWebhook(opts);
  if (!r.ok) throw new WebhookVerificationError(r.reason, r.status);
  return r;
}
