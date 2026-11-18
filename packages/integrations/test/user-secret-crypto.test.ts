import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { LocalKeyProvider, TokenCipher, TokenDecryptionError, userSecretAad } from '../src';
import { ORG, INTEGRATION } from './helpers';

const USER = '00000000-0000-4000-8000-0000000000a1';
const OTHER_USER = '00000000-0000-4000-8000-0000000000a2';
const FACTOR = '00000000-0000-4000-8000-0000000000f1';
const OTHER_FACTOR = '00000000-0000-4000-8000-0000000000f2';
const ctx = { purpose: 'mfa.totp' as const, userId: USER, factorId: FACTOR };
const SECRET = 'placeholder-totp-secret-not-real';

describe('TokenCipher user secrets (ADR-021, #456 P-3)', () => {
  const c = new TokenCipher(new LocalKeyProvider({ k1: randomBytes(32) }, 'k1'));

  it('round-trips in the same v1 envelope without the plaintext', async () => {
    const env = await c.encryptUserSecret(SECRET, ctx);
    expect(env.startsWith('v1.k1.')).toBe(true);
    expect(env).not.toContain(SECRET);
    expect(await c.decryptUserSecret(env, ctx)).toBe(SECRET);
  });

  it('is bound to the user and the factor: a copied blob fails', async () => {
    const env = await c.encryptUserSecret(SECRET, ctx);
    await expect(c.decryptUserSecret(env, { ...ctx, userId: OTHER_USER })).rejects.toBeInstanceOf(
      TokenDecryptionError,
    );
    await expect(
      c.decryptUserSecret(env, { ...ctx, factorId: OTHER_FACTOR }),
    ).rejects.toBeInstanceOf(TokenDecryptionError);
  });

  it('never opens as an integration token (distinct AAD label), and vice versa', async () => {
    const env = await c.encryptUserSecret(SECRET, ctx);
    await expect(
      c.decrypt(env, { organizationId: USER, integrationId: FACTOR }),
    ).rejects.toBeInstanceOf(TokenDecryptionError);
    const tok = await c.encrypt(SECRET, { organizationId: ORG, integrationId: INTEGRATION });
    await expect(
      c.decryptUserSecret(tok, { purpose: 'mfa.totp', userId: ORG, factorId: INTEGRATION }),
    ).rejects.toBeInstanceOf(TokenDecryptionError);
  });

  it('requires every context field', () => {
    expect(() => userSecretAad({ ...ctx, userId: '' })).toThrow();
    expect(() => userSecretAad({ ...ctx, factorId: '' })).toThrow();
    expect(() => userSecretAad({ ...ctx, purpose: 'other' as 'mfa.totp' })).toThrow();
    expect(userSecretAad(ctx).toString('utf8')).toBe(
      JSON.stringify(['meetops.mfa.totp.v1', USER, FACTOR]),
    );
  });
});
