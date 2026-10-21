import { describe, it, expect } from 'vitest';
import { assertSafeEndpoint, isPrivateAddress, guardedFetch, InMemoryAuditSink, ProviderRegistry, endpointPolicyFromEnv, loadAIEnv } from '../src/index.js';
import { fakeLLM, llmCfg } from './helpers.js';

const policy = { allowedHosts: ['api.example.com'], allowedLocalOrigins: ['http://localhost:11434'] };
const pub = async () => [{ address: '93.184.216.34', family: 4 }];

describe('SSRF guard', () => {
  it.each([
    '10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.5.5', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '::1', '::', 'fc00::1', 'fd00:ec2::254', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:8.8.8.8',
  ])('blocks %s', (ip) => expect(isPrivateAddress(ip)).toBe(true));
  it.each(['8.8.8.8', '2606:4700:4700::1111'])('allows public %s', (ip) => expect(isPrivateAddress(ip)).toBe(false));

  it('HTTPS only for remote', async () => {
    await expect(assertSafeEndpoint('http://api.example.com/x', policy, pub)).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
  });
  it('host must be allowlisted', async () => {
    await expect(assertSafeEndpoint('https://evil.com/x', policy, pub)).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
  });
  it('rejects if ANY resolved address is private (DNS rebinding style)', async () => {
    const mixed = async () => [{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }];
    await expect(assertSafeEndpoint('https://api.example.com/x', policy, mixed)).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
  });
  it('returns pinned IP for allowed host', async () => {
    const r = await assertSafeEndpoint('https://api.example.com/x', policy, pub);
    expect(r.pinned).toEqual({ address: '93.184.216.34', family: 4 });
  });
  it('rejects userinfo and non-http schemes', async () => {
    await expect(assertSafeEndpoint('https://u:p@api.example.com/', policy, pub)).rejects.toBeDefined();
    await expect(assertSafeEndpoint('file:///etc/passwd', policy, pub)).rejects.toBeDefined();
  });
  it('local origin allowed only if explicitly allowlisted (enabled)', async () => {
    expect((await assertSafeEndpoint('http://localhost:11434/api/tags', policy, pub)).local).toBe(true);
    await expect(assertSafeEndpoint('http://localhost:9999/', policy, pub)).rejects.toBeDefined();
    const disabled = endpointPolicyFromEnv(loadAIEnv({}).env);
    expect(disabled.allowedLocalOrigins).toEqual([]);
    expect(endpointPolicyFromEnv(loadAIEnv({ OLLAMA_ENABLED: 'true' }).env).allowedLocalOrigins).toEqual(['http://localhost:11434']);
  });
  it('guardedFetch passes a pinned dispatcher and refuses redirects', async () => {
    let seen: unknown;
    const f = async (_u: string, init?: { dispatcher?: unknown; redirect?: string }) => {
      seen = init;
      return new Response('', { status: 302, headers: { location: 'http://169.254.169.254/' } });
    };
    await expect(guardedFetch({ baseUrl: 'https://api.example.com', policy, provider: 'p', fetch: f, lookup: pub }, 'x')).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
    expect((seen as { redirect: string }).redirect).toBe('manual');
    expect((seen as { dispatcher?: unknown }).dispatcher).toBeDefined();
  });
  it('guardedFetch caps response size', async () => {
    const f = async () => new Response('x'.repeat(100), { status: 200 });
    await expect(guardedFetch({ baseUrl: 'https://api.example.com', policy, provider: 'p', fetch: f, lookup: pub, maxResponseBytes: 10 }, 'x')).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });
});

describe('audit hook', () => {
  it('emits redacted events for provider config changes', () => {
    const audit = new InMemoryAuditSink();
    const reg = new ProviderRegistry({ gemini: () => fakeLLM('gemini') }, () => 'sk-secret', audit);
    reg.register(llmCfg('gemini', { credentialRef: 'env:GEMINI_API_KEY' }), 'user-1');
    reg.register(llmCfg('gemini', { enabled: false, credentialRef: 'env:GEMINI_API_KEY' }), 'user-1');
    expect(audit.events.map((e) => e.action)).toEqual(['create', 'update']);
    expect(JSON.stringify(audit.events)).not.toContain('sk-secret');
    expect(JSON.stringify(audit.events)).not.toContain('GEMINI_API_KEY');
  });
});
