import { describe, expect, it } from 'vitest';
import { assertSafeEndpoint } from '../src/security/ssrf.js';

const policy = { allowedHosts: ['api.openai.com'], allowedLocalOrigins: ['http://localhost:11434'] };
const pub = async () => [{ address: '104.18.0.1', family: 4 }];

describe('SEC-BUG-1: remote endpoints only on port 443', () => {
  it('blocks non-443 ports on an allowlisted host', async () => {
    await expect(assertSafeEndpoint('https://api.openai.com:8443/', policy, pub)).rejects.toThrow(/Port 8443 not allowed/);
    await expect(assertSafeEndpoint('https://api.openai.com:80/', policy, pub)).rejects.toThrow(/Port 80 not allowed/);
  });
  it('allows explicit :443 and no port', async () => {
    await expect(assertSafeEndpoint('https://api.openai.com:443/', policy, pub)).resolves.toMatchObject({ pinned: { address: '104.18.0.1' } });
    await expect(assertSafeEndpoint('https://api.openai.com/', policy, pub)).resolves.toMatchObject({ pinned: { address: '104.18.0.1' } });
  });
  it('enabled exact local origins keep their port (Ollama :11434); other local ports stay blocked', async () => {
    await expect(assertSafeEndpoint('http://localhost:11434/api/chat', policy, pub)).resolves.toBeDefined();
    await expect(assertSafeEndpoint('http://localhost:11435/api/chat', policy, pub)).rejects.toThrow();
  });
});
