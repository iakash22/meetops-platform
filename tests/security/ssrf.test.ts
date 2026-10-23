import { describe, expect, it } from 'vitest';
import { ssrfScenarios, ssrfUrlPayloads } from '../fixtures/security/ssrf.js';

// TODO(QA): point these at the real outbound-URL validator (AI provider registry,
// webhooks, integrations, media import) once one exists. Expected: rejected before connecting.
describe.skip('SSRF: static URL payloads rejected by outbound URL validator', () => {
  it.each(ssrfUrlPayloads)('[$id] rejects $url', () => {
    expect.fail('validator not implemented');
  });
});

describe.skip('SSRF: harness scenarios', () => {
  it.each(ssrfScenarios)('[$id] $description', () => {
    expect.fail('needs test server / DNS / TLS harness');
  });
});
