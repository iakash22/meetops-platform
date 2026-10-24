import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { LocalKeyProvider, TokenCipher, TokenDecryptionError, tokenAad } from '../src';
import { ORG, OTHER_ORG, INTEGRATION } from './helpers';

const k1 = randomBytes(32);
const k2 = randomBytes(32);
const ctx = { organizationId: ORG, integrationId: INTEGRATION };
const SECRET = 'placeholder-access-token-not-real';

describe('TokenCipher (AES-256-GCM envelope)', () => {
  it('round-trips and never contains the plaintext', async () => {
    const c = new TokenCipher(new LocalKeyProvider({ k1 }, 'k1'));
    const env = await c.encrypt(SECRET, ctx);
    expect(env.startsWith('v1.k1.')).toBe(true);
    expect(env).not.toContain(SECRET);
    expect(await c.decrypt(env, ctx)).toBe(SECRET);
  });
  it('uses a fresh IV and data key per record', async () => {
    const c = new TokenCipher(new LocalKeyProvider({ k1 }, 'k1'));
    const [a, b] = [await c.encrypt(SECRET, ctx), await c.encrypt(SECRET, ctx)];
    expect(a).not.toBe(b);
    const iv = (e: string) => Buffer.from(e.split('.')[3]!, 'base64url').subarray(0, 12).toString('hex');
    expect(iv(String(a))).not.toBe(iv(String(b)));
    expect(Buffer.from(String(String(a).split('.')[3]), 'base64url').length).toBe(12 + Buffer.byteLength(SECRET) + 16);
  });
  it('binds ciphertext to organizationId + integrationId (AAD)', async () => {
    const c = new TokenCipher(new LocalKeyProvider({ k1 }, 'k1'));
    const env = await c.encrypt(SECRET, ctx);
    await expect(c.decrypt(env, { organizationId: OTHER_ORG, integrationId: INTEGRATION })).rejects.toBeInstanceOf(TokenDecryptionError);
    await expect(c.decrypt(env, { organizationId: ORG, integrationId: 'other' })).rejects.toBeInstanceOf(TokenDecryptionError);
    expect(() => tokenAad({ organizationId: '', integrationId: 'x' })).toThrow();
  });
  it('detects tampering and malformed envelopes without leaking details', async () => {
    const c = new TokenCipher(new LocalKeyProvider({ k1 }, 'k1'));
    const env = await c.encrypt(SECRET, ctx);
    const p = env.split('.');
    const body = Buffer.from(String(p[3]), 'base64url');
    body[14]! ^= 1;
    await expect(c.decrypt([p[0], p[1], p[2], body.toString('base64url')].join('.'), ctx)).rejects.toThrow('Token decryption failed');
    for (const bad of ['', 'v2.k1.a.b', 'v1.k1.a', 'v1.bad id.a.b', 'v1.k1.!!.b']) await expect(c.decrypt(bad, ctx)).rejects.toBeInstanceOf(TokenDecryptionError);
  });
  it('supports key rotation by key id', async () => {
    const old = new TokenCipher(new LocalKeyProvider({ k1 }, 'k1'));
    const env = await old.encrypt(SECRET, ctx);
    const rotated = new TokenCipher(new LocalKeyProvider({ k1, k2 }, 'k2'));
    expect(await rotated.decrypt(env, ctx)).toBe(SECRET);
    expect(await rotated.needsRotation(env)).toBe(true);
    const env2 = await rotated.rotate(env, ctx);
    expect(TokenCipher.keyIdOf(env2)).toBe('k2');
    expect(await rotated.needsRotation(env2)).toBe(false);
    await expect(old.decrypt(env2, ctx)).rejects.toThrow(/Unknown key id/);
  });
  it('works with an injected (KMS-style) provider and validates keys', async () => {
    const local = new LocalKeyProvider({ 'kms:1': k1 }, 'kms:1');
    const wrap = vi.fn(local.wrap.bind(local));
    const c = new TokenCipher({ currentKeyId: async () => 'kms:1', wrap, unwrap: local.unwrap.bind(local) });
    expect(await c.decrypt(await c.encrypt(SECRET, ctx), ctx)).toBe(SECRET);
    expect(wrap.mock.calls[0]![2].toString()).toContain(ORG);
    expect(() => new LocalKeyProvider({ k1: randomBytes(16) }, 'k1')).toThrow(/32 bytes/);
    expect(() => new LocalKeyProvider({ k1 }, 'nope')).toThrow();
  });
});
