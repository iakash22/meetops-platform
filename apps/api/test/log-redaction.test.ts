import { describe, expect, it } from 'vitest';
import { REDACT_KEYS } from '@meetops/contracts';
import { createLogger, DEFAULT_REDACT_KEYS } from '@meetops/logger';

describe('api log redaction (ADR-005 A1.5)', () => {
  it('redacts every contracts REDACT_KEYS entry at any depth, any case, in objects and child bindings', () => {
    const lines: string[] = [];
    const log = createLogger(
      { redactKeys: REDACT_KEYS },
      { write: (l: string) => void lines.push(l) },
    );
    const nested = Object.fromEntries(REDACT_KEYS.map((k, i) => [k.toUpperCase(), `LEAK_${i}`]));
    log
      .child({ ctx: { inner: { refreshToken: 'LEAK_child' } } })
      .info(
        { a: { b: { c: { d: nested, keep: 'visible' } } }, list: [{ accessToken: 'LEAK_arr' }] },
        'm',
      );
    const out = lines.join('');
    expect(out).not.toContain('LEAK_');
    expect(out).toContain('visible');
    expect(out).toContain('***redacted***');
  });

  it('logger defaults already cover every REDACT_KEYS entry', () => {
    for (const k of REDACT_KEYS) expect(DEFAULT_REDACT_KEYS).toContain(k);
  });
});

describe('request URL redaction (#282 M-2)', () => {
  it('logs the OAuth callback URL without code/state/token values', async () => {
    const { default: Fastify } = await import('fastify');
    const lines: string[] = [];
    const app = Fastify({
      loggerInstance: createLogger(
        { level: 'info', redactKeys: REDACT_KEYS },
        { write: (l: string) => void lines.push(l) },
      ) as never,
    });
    app.get('/integrations/:provider/callback', async () => ({ ok: true }));
    await app.inject({
      method: 'GET',
      url: '/integrations/jira/callback?code=LEAKCODE123&state=LEAKSTATE456&installation_id=99&token=LEAKTOK',
    });
    await app.close();
    const out = lines.join('');
    expect(out).toContain('/integrations/jira/callback?code=***redacted***');
    expect(out).toContain('installation_id=99');
    expect(out).not.toMatch(/LEAKCODE|LEAKSTATE|LEAKTOK/);
  });

  it('contracts and logger agree on conditional `code` redaction', async () => {
    const { REDACT_CONDITIONAL_KEYS } = await import('@meetops/contracts');
    const { CONDITIONAL_REDACT_KEYS } = await import('@meetops/logger');
    expect([...CONDITIONAL_REDACT_KEYS]).toEqual([...REDACT_CONDITIONAL_KEYS]);
  });
});
