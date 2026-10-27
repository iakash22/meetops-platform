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
