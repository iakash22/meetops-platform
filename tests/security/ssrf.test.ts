import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { ALLOWED_HOST, ssrfUrlPayloads } from '../fixtures/security/ssrf.js';

/*
 * SS cases against PR #21's assertSafeEndpoint (packages/ai-core/src/security/ssrf.ts).
 * Uses this repo's packages/ai-core once #21 is merged; until then point QA_AI_CORE_DIR at a
 * checkout of feat/ai-provider-registry. Skipped (with a warning) when neither has it.
 * DNS is always faked (no network): ALLOWED_HOST resolves to a public documentation-safe IP.
 */
const aiCoreDir = resolve(
  process.env.QA_AI_CORE_DIR ?? fileURLToPath(new URL('../../packages/ai-core', import.meta.url)),
);
const ssrfModule = join(aiCoreDir, 'src/security/ssrf.ts');
const available = existsSync(ssrfModule);
if (!available)
  console.warn(
    `[security/ssrf] ${ssrfModule} not found: skipping (PR #21 not merged; set QA_AI_CORE_DIR)`,
  );

type Policy = { allowedHosts: string[]; allowedLocalOrigins: string[] };
type Lookup = (host: string) => Promise<Array<{ address: string; family: number }>>;
type Assert = (
  url: string,
  policy: Policy,
  lookup?: Lookup,
) => Promise<{ url: URL; local: boolean; pinned?: { address: string; family: 4 | 6 } }>;

const PUBLIC_IP = '93.184.216.34';
const DNS: Record<string, string[]> = {
  [ALLOWED_HOST]: [PUBLIC_IP],
  'metadata.google.internal': ['169.254.169.254'],
  'localtest.me': ['127.0.0.1'],
  'evil.example': [PUBLIC_IP],
};
const lookup: Lookup = async (host) =>
  (DNS[host] ?? []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
const strict: Policy = { allowedHosts: [ALLOWED_HOST], allowedLocalOrigins: [] };

const hostOf = (raw: string) => {
  try {
    return new URL(raw).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return '';
  }
};

describe.skipIf(!available)('SSRF: assertSafeEndpoint (PR #21)', () => {
  let assertSafeEndpoint: Assert;
  beforeAll(async () => {
    ({ assertSafeEndpoint } = (await import(pathToFileURL(ssrfModule).href)) as {
      assertSafeEndpoint: Assert;
    });
  });

  it('control: the allowlisted host on https resolves and is pinned to its public IP', async () => {
    const r = await assertSafeEndpoint(`https://${ALLOWED_HOST}/v1`, strict, lookup);
    expect(r.local).toBe(false);
    expect(r.pinned).toEqual({ address: PUBLIC_IP, family: 4 });
  });

  // SS-28 is asserted separately below (SEC-BUG-1).
  it.each(ssrfUrlPayloads.filter((p) => p.id !== 'SS-28'))(
    '[$id] rejects $url with the production-style allowlist',
    async ({ url }) => {
      await expect(assertSafeEndpoint(url, strict, lookup)).rejects.toMatchObject({
        code: 'SSRF_BLOCKED',
      });
    },
  );

  // Defence in depth: even if an operator allowlists the hostname itself, private/reserved
  // targets (IP literals, encodings, metadata, internal DNS) must still be rejected.
  const ipLike = ssrfUrlPayloads.filter((p) =>
    ['private-ipv4', 'loopback', 'ip-encoding', 'metadata', 'ipv6', 'dns'].includes(p.category),
  );
  it.each(ipLike)('[$id] rejects $url even when its own host is allowlisted', async ({ url }) => {
    const policy: Policy = { allowedHosts: [hostOf(url)], allowedLocalOrigins: [] };
    await expect(assertSafeEndpoint(url, policy, lookup)).rejects.toMatchObject({
      code: 'SSRF_BLOCKED',
    });
  });

  it('[SS-18] a host resolving to public AND private addresses is rejected; the pin is the validated IP', async () => {
    const mixed: Lookup = async () => [
      { address: PUBLIC_IP, family: 4 },
      { address: '127.0.0.1', family: 4 },
    ];
    await expect(
      assertSafeEndpoint(`https://${ALLOWED_HOST}/`, strict, mixed),
    ).rejects.toMatchObject({
      code: 'SSRF_BLOCKED',
    });
    // Rebinding defence: callers connect to the pinned, validated address, not a fresh lookup.
    const r = await assertSafeEndpoint(`https://${ALLOWED_HOST}/`, strict, lookup);
    expect(r.pinned?.address).toBe(PUBLIC_IP);
  });

  // SEC-BUG-1 (PR #21 8ba69b7): assertSafeEndpoint checks scheme, host and resolved IPs but not
  // the port, so https://allowed.example:6379/ passes. Expected-fail until a port allowlist lands.
  it.fails(
    '[SS-28] (SEC-BUG-1) a non-default port on the allowlisted host is rejected',
    async () => {
      await expect(
        assertSafeEndpoint(`https://${ALLOWED_HOST}:6379/`, strict, lookup),
      ).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
    },
  );
});
