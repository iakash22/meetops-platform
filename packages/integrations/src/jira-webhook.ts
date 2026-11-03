import {
  checkJiraWebhookFreshness,
  effectiveReplayTtlSeconds,
  recordDeliveryOutcome,
  verifyGitHubSignature,
  type DeliveryStore,
  type HeaderBag,
} from './webhook.js';

/**
 * Jira Cloud webhooks registered with a secret send `X-Hub-Signature: sha256=<hex>` (HMAC-SHA256 of the raw body)
 * and a per-delivery `X-Atlassian-Webhook-Identifier`. Order: size cap -> signature (constant time) -> payload ->
 * freshness (body timestamp, covered by the signature) -> replay mark (only after a valid signature).
 */
export type JiraWebhookFailure =
  | 'missing_signature'
  | 'malformed_signature'
  | 'invalid_signature'
  | 'missing_delivery_id'
  | 'invalid_payload'
  | 'stale_event'
  | 'replayed_delivery'
  | 'delivery_in_progress'
  | 'payload_too_large';

export type JiraWebhookResult =
  | { ok: true; deliveryId: string; payload: unknown }
  | { ok: false; reason: JiraWebhookFailure; status: 400 | 401 | 409 | 413 };

const STATUS: Record<JiraWebhookFailure, 400 | 401 | 409 | 413> = {
  missing_signature: 401,
  malformed_signature: 401,
  invalid_signature: 401,
  missing_delivery_id: 400,
  invalid_payload: 400,
  stale_event: 409,
  replayed_delivery: 409,
  delivery_in_progress: 409,
  payload_too_large: 413,
};

function header(headers: HeaderBag, name: string): string | undefined {
  if (typeof Headers !== 'undefined' && headers instanceof Headers)
    return headers.get(name) ?? undefined;
  const bag = headers as Record<string, string | string[] | undefined>;
  const key = Object.keys(bag).find((k) => k.toLowerCase() === name);
  const v = key ? bag[key] : undefined;
  return Array.isArray(v) ? v[0] : v;
}

export async function verifyJiraWebhook(opts: {
  secret: string;
  /** Namespaces delivery ids in the shared store (Jira ids are only unique per site). */
  integrationId: string;
  rawBody: string | Uint8Array;
  headers: HeaderBag;
  deliveryStore: DeliveryStore;
  replayTtlSeconds?: number;
  maxBodyBytes?: number;
  /** Max event age by body timestamp. Default 1 day. */
  maxAgeSeconds?: number;
  now?: () => number;
  /** See VerifyWebhookOptions.beforeRecord: throwing here records nothing. */
  beforeRecord?: () => Promise<void>;
}): Promise<JiraWebhookResult> {
  const fail = (reason: JiraWebhookFailure) => ({
    ok: false as const,
    reason,
    status: STATUS[reason],
  });
  const size =
    typeof opts.rawBody === 'string' ? Buffer.byteLength(opts.rawBody) : opts.rawBody.byteLength;
  if (size > (opts.maxBodyBytes ?? 1024 * 1024)) return fail('payload_too_large');
  const sigErr = verifyGitHubSignature(
    opts.secret,
    opts.rawBody,
    header(opts.headers, 'x-hub-signature'),
  );
  if (sigErr) return fail(sigErr as JiraWebhookFailure);
  const id = header(opts.headers, 'x-atlassian-webhook-identifier')?.trim();
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return fail('missing_delivery_id');
  let payload: unknown;
  try {
    payload = JSON.parse(
      typeof opts.rawBody === 'string' ? opts.rawBody : Buffer.from(opts.rawBody).toString('utf8'),
    );
  } catch {
    return fail('invalid_payload');
  }
  const freshOpts = {
    maxAgeSeconds: opts.maxAgeSeconds ?? 86_400,
    ...(opts.now ? { now: opts.now } : {}),
  };
  const fresh = checkJiraWebhookFreshness(payload, freshOpts);
  if (fresh !== 'fresh' && fresh !== 'absent') return fail('stale_event');
  const deliveryId = `jira:${opts.integrationId}:${id}`;
  const outcome = await recordDeliveryOutcome(
    opts.deliveryStore,
    deliveryId,
    effectiveReplayTtlSeconds(opts.replayTtlSeconds),
    opts.beforeRecord,
  );
  if (outcome === 'replayed') return fail('replayed_delivery');
  if (outcome === 'in_progress') return fail('delivery_in_progress');
  return { ok: true, deliveryId, payload };
}
