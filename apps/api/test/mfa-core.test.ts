/** ADR-021 MFA core: RFC 4226/6238 vectors, constant-time window check, replay guard, recovery codes. */
import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  otpauthUri,
  totpAt,
  totpStep,
  verifyTotp,
} from '../src/modules/mfa/domain/totp.js';
import {
  RECOVERY_CODE_COUNT,
  generateRecoveryCodes,
  generateRecoveryKey,
  hashRecoveryCode,
  normalizeRecoveryCode,
  recoveryHashEquals,
} from '../src/modules/mfa/domain/recovery-codes.js';
import {
  decodeSecretPayload,
  encodeSecretPayload,
} from '../src/modules/mfa/domain/secret-payload.js';
import {
  hasFreshStepUp,
  stepUpExpiresAt,
  toSessionAuthLevel,
  STEP_UP_WINDOW_MS,
} from '../src/modules/auth/domain/session.js';

/** RFC test key "12345678901234567890", built at run time (no secret-looking literal). */
const KEY = Buffer.from('12345678901234567890', 'ascii');
const KEY_B32 = base32Encode(KEY);

describe('base32 (RFC 4648)', () => {
  it('round-trips and matches the RFC 4648 vectors', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
    expect(base32Decode('mzxw6ytboi======').toString()).toBe('foobar');
    const r = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 37) & 0xff));
    expect(base32Decode(base32Encode(r)).equals(r)).toBe(true);
  });
  it('rejects non-base32 input', () => {
    expect(() => base32Decode('ABC1')).toThrow();
  });
  it('generates 160-bit secrets', () => {
    const s = generateTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(s)).toHaveLength(20);
    expect(generateTotpSecret()).not.toBe(s);
  });
});

describe('HOTP / TOTP vectors', () => {
  it('RFC 4226 Appendix D HOTP values', () => {
    const expected = [
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ];
    expected.forEach((v, i) => expect(hotp(KEY, i)).toBe(v));
  });
  it('RFC 6238 Appendix B SHA-1 values (8 digits)', () => {
    const cases: [number, string][] = [
      [59, '94287082'],
      [1_111_111_109, '07081804'],
      [1_111_111_111, '14050471'],
      [1_234_567_890, '89005924'],
      [2_000_000_000, '69279037'],
      [20_000_000_000, '65353130'],
    ];
    for (const [t, v] of cases) expect(totpAt(KEY_B32, t * 1000, 8)).toBe(v);
  });
});

describe('verifyTotp', () => {
  const now = 1_700_000_000_000;
  const step = totpStep(now);
  it('accepts the current code and returns its step', () => {
    expect(
      verifyTotp({
        secretB32: KEY_B32,
        code: totpAt(KEY_B32, now),
        nowMs: now,
        lastUsedStep: null,
      }),
    ).toBe(step);
  });
  it('accepts +/-1 step of skew, not +/-2', () => {
    const at = (d: number) => totpAt(KEY_B32, now + d * 30_000);
    expect(verifyTotp({ secretB32: KEY_B32, code: at(-1), nowMs: now, lastUsedStep: null })).toBe(
      step - 1,
    );
    expect(verifyTotp({ secretB32: KEY_B32, code: at(1), nowMs: now, lastUsedStep: null })).toBe(
      step + 1,
    );
    expect(
      verifyTotp({ secretB32: KEY_B32, code: at(-2), nowMs: now, lastUsedStep: null }),
    ).toBeNull();
    expect(
      verifyTotp({ secretB32: KEY_B32, code: at(2), nowMs: now, lastUsedStep: null }),
    ).toBeNull();
  });
  it('replay guard: a step at or below lastUsedStep never verifies', () => {
    const code = totpAt(KEY_B32, now);
    expect(verifyTotp({ secretB32: KEY_B32, code, nowMs: now, lastUsedStep: step })).toBeNull();
    expect(verifyTotp({ secretB32: KEY_B32, code, nowMs: now, lastUsedStep: step + 1 })).toBeNull();
    expect(verifyTotp({ secretB32: KEY_B32, code, nowMs: now, lastUsedStep: step - 1 })).toBe(step);
    // An older code is refused once a newer step was used.
    const older = totpAt(KEY_B32, now - 30_000);
    expect(
      verifyTotp({ secretB32: KEY_B32, code: older, nowMs: now, lastUsedStep: step }),
    ).toBeNull();
  });
  it('rejects wrong and malformed codes', () => {
    const good = totpAt(KEY_B32, now);
    const wrong = String((Number(good) + 1) % 1_000_000).padStart(6, '0');
    for (const code of [wrong, '', '12345', '1234567', 'abcdef', ' 123456', '000000x'])
      expect(
        verifyTotp({ secretB32: KEY_B32, code, nowMs: now, lastUsedStep: null }),
        code,
      ).toBeNull();
  });
});

describe('otpauth URI', () => {
  it('has issuer, label, secret and the RFC 6238 parameters', () => {
    const u = new URL(otpauthUri(KEY_B32, 'ada@example.com'));
    expect(u.protocol).toBe('otpauth:');
    expect(u.host).toBe('totp');
    expect(decodeURIComponent(u.pathname)).toBe('/MeetOps:ada@example.com');
    expect(u.searchParams.get('secret')).toBe(KEY_B32);
    expect(u.searchParams.get('issuer')).toBe('MeetOps');
    expect(u.searchParams.get('algorithm')).toBe('SHA1');
    expect(u.searchParams.get('digits')).toBe('6');
    expect(u.searchParams.get('period')).toBe('30');
  });
});

describe('recovery codes', () => {
  it('generates 10 distinct xxxxx-xxxxx codes with matching HMACs', () => {
    const r = generateRecoveryKey();
    const { codes, hashes } = generateRecoveryCodes(r);
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const [i, c] of codes.entries()) {
      expect(c).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/);
      expect(hashes[i]).toBe(hashRecoveryCode(r, normalizeRecoveryCode(c)!));
      expect(hashes[i]).not.toContain(c.replace('-', ''));
    }
  });
  it('normalizes case, spaces and dashes; rejects anything else', () => {
    expect(normalizeRecoveryCode('abcde-fgh23')).toBe('ABCDEFGH23');
    expect(normalizeRecoveryCode(' ABCDE FGH23 ')).toBe('ABCDEFGH23');
    for (const bad of ['abcde-fgh2', 'abcde-fgh234', 'abcde-fgh01', '', '----------'])
      expect(normalizeRecoveryCode(bad), bad).toBeNull();
  });
  it('hashes are keyed: another factor key gives another hash', () => {
    const n = 'ABCDEFGH23';
    expect(hashRecoveryCode(generateRecoveryKey(), n)).not.toBe(
      hashRecoveryCode(generateRecoveryKey(), n),
    );
  });
  it('compares hashes in constant time and refuses empty/mismatched lengths', () => {
    const h = hashRecoveryCode(generateRecoveryKey(), 'ABCDEFGH23');
    expect(recoveryHashEquals(h, h)).toBe(true);
    expect(recoveryHashEquals(h, h.slice(0, -2))).toBe(false);
    expect(recoveryHashEquals('', '')).toBe(false);
  });
});

describe('encrypted payload codec', () => {
  it('round-trips and rejects malformed payloads', () => {
    const p = decodeSecretPayload(encodeSecretPayload({ s: KEY_B32, r: 'k' }));
    expect(p).toEqual({ v: 1, s: KEY_B32, r: 'k' });
    for (const bad of [
      '{}',
      '{"v":2,"s":"a","r":"b"}',
      '{"v":1,"s":"","r":"b"}',
      '{"v":1,"s":"a"}',
    ])
      expect(() => decodeSecretPayload(bad), bad).toThrow();
  });
});

describe('session step-up freshness (ADR-021 D4, OQ-1)', () => {
  const now = new Date('2026-11-11T12:00:00.000Z');
  it('only an mfa session with a recent mfaAt is fresh', () => {
    const at = new Date(now.getTime() - 60_000);
    expect(hasFreshStepUp({ authLevel: 'mfa', mfaAt: at }, now)).toBe(true);
    expect(stepUpExpiresAt({ authLevel: 'mfa', mfaAt: at })?.getTime()).toBe(
      at.getTime() + STEP_UP_WINDOW_MS,
    );
    expect(hasFreshStepUp({ authLevel: 'mfa', mfaAt: null }, now)).toBe(false);
    expect(hasFreshStepUp({ authLevel: 'password', mfaAt: at }, now)).toBe(false);
    expect(hasFreshStepUp({ authLevel: 'google', mfaAt: at }, now)).toBe(false);
    expect(stepUpExpiresAt({ authLevel: 'password', mfaAt: at })).toBeNull();
  });
  it('expires after the window and refuses a future mfaAt', () => {
    const old = new Date(now.getTime() - STEP_UP_WINDOW_MS);
    expect(hasFreshStepUp({ authLevel: 'mfa', mfaAt: old }, now)).toBe(false);
    const future = new Date(now.getTime() + 60_000);
    expect(hasFreshStepUp({ authLevel: 'mfa', mfaAt: future }, now)).toBe(false);
  });
  it('unknown stored levels read back as password', () => {
    expect(toSessionAuthLevel('admin')).toBe('password');
    expect(toSessionAuthLevel(null)).toBe('password');
    expect(toSessionAuthLevel('mfa')).toBe('mfa');
  });
});
