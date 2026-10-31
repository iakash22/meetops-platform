import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Key-encryption-key (KEK) provider. Implement with KMS / secret manager in production (wrap/unwrap the per-record
 * data key remotely); `LocalKeyProvider` wraps locally with AES-256-GCM for dev/tests. Key ids allow rotation:
 * new records use `currentKeyId()`, old records still decrypt with their recorded key id.
 */
export interface KeyEncryptionProvider {
  currentKeyId(): string | Promise<string>;
  wrap(keyId: string, dataKey: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
  unwrap(keyId: string, wrapped: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
}

export interface TokenEncryptionContext {
  organizationId: string;
  integrationId: string;
}

export class TokenDecryptionError extends Error {
  constructor(message = 'Token decryption failed') {
    super(message);
    this.name = 'TokenDecryptionError';
  }
}

const KEY_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function gcmEncrypt(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Buffer {
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]);
}

function gcmDecrypt(key: Uint8Array, blob: Uint8Array, aad: Uint8Array): Buffer {
  if (blob.length < IV_BYTES + TAG_BYTES) throw new TokenDecryptionError();
  const b = Buffer.from(blob);
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, IV_BYTES), {
    authTagLength: TAG_BYTES,
  });
  d.setAAD(aad);
  d.setAuthTag(b.subarray(b.length - TAG_BYTES));
  try {
    return Buffer.concat([d.update(b.subarray(IV_BYTES, b.length - TAG_BYTES)), d.final()]);
  } catch {
    throw new TokenDecryptionError();
  }
}

/** Local AES-256-GCM KEKs keyed by id (32-byte keys). Dev/test, or when keys come from a secret manager at boot. */
export class LocalKeyProvider implements KeyEncryptionProvider {
  private readonly keys: Map<string, Buffer>;
  constructor(
    keys: Record<string, Uint8Array>,
    private readonly current: string,
  ) {
    this.keys = new Map();
    for (const [id, k] of Object.entries(keys)) {
      if (!KEY_ID_RE.test(id)) throw new Error('Invalid key id');
      if (k.length !== 32) throw new Error('KEK must be 32 bytes');
      this.keys.set(id, Buffer.from(k));
    }
    if (!this.keys.has(current)) throw new Error('Current key id not configured');
  }
  currentKeyId() {
    return this.current;
  }
  private key(id: string) {
    const k = this.keys.get(id);
    if (!k) throw new TokenDecryptionError('Unknown key id');
    return k;
  }
  async wrap(keyId: string, dataKey: Uint8Array, aad: Uint8Array) {
    return gcmEncrypt(this.key(keyId), dataKey, aad);
  }
  async unwrap(keyId: string, wrapped: Uint8Array, aad: Uint8Array) {
    return gcmDecrypt(this.key(keyId), wrapped, aad);
  }
}

/** AAD binds ciphertext to its tenant row: a blob copied to another org/integration fails to decrypt. */
export function tokenAad(ctx: TokenEncryptionContext): Buffer {
  if (!ctx.organizationId || !ctx.integrationId)
    throw new Error('organizationId and integrationId are required');
  return Buffer.from(
    JSON.stringify(['meetops.token.v1', ctx.organizationId, ctx.integrationId]),
    'utf8',
  );
}

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const unb64u = (s: string) => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new TokenDecryptionError();
  return Buffer.from(s, 'base64url');
};

/**
 * Envelope encryption: a fresh random 256-bit data key per record encrypts the plaintext with AES-256-GCM (random
 * 12-byte IV, AAD = org+integration); the data key is wrapped by the KEK (same AAD). Format (single text column):
 * `v1.<keyId>.<wrappedKey b64u>.<iv|ciphertext|tag b64u>`. Plaintext is never logged or included in errors.
 */
export class TokenCipher {
  constructor(private readonly kek: KeyEncryptionProvider) {}

  async encrypt(plaintext: string, ctx: TokenEncryptionContext): Promise<string> {
    const aad = tokenAad(ctx);
    const keyId = await this.kek.currentKeyId();
    if (!KEY_ID_RE.test(keyId)) throw new Error('Invalid key id');
    const dek = randomBytes(32);
    try {
      const wrapped = await this.kek.wrap(keyId, dek, aad);
      const body = gcmEncrypt(dek, Buffer.from(plaintext, 'utf8'), aad);
      return ['v1', keyId, b64u(wrapped), b64u(body)].join('.');
    } finally {
      dek.fill(0);
    }
  }

  async decrypt(envelope: string, ctx: TokenEncryptionContext): Promise<string> {
    const aad = tokenAad(ctx);
    const parts = envelope.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1' || !KEY_ID_RE.test(parts[1] ?? ''))
      throw new TokenDecryptionError('Malformed token envelope');
    const [, keyId, wrapped, body] = parts as [string, string, string, string];
    const dek = await this.kek.unwrap(keyId, unb64u(wrapped), aad);
    try {
      if (dek.length !== 32) throw new TokenDecryptionError();
      return gcmDecrypt(dek, unb64u(body), aad).toString('utf8');
    } finally {
      Buffer.from(dek.buffer, dek.byteOffset, dek.byteLength).fill(0);
    }
  }

  /** Key id an envelope was written with (for rotation jobs / the `token_key_id` column). */
  static keyIdOf(envelope: string): string | undefined {
    const p = envelope.split('.');
    return p.length === 4 && p[0] === 'v1' && KEY_ID_RE.test(p[1] ?? '') ? p[1] : undefined;
  }

  async needsRotation(envelope: string): Promise<boolean> {
    return TokenCipher.keyIdOf(envelope) !== (await this.kek.currentKeyId());
  }

  /** Re-encrypt under the current key (rotation). */
  async rotate(envelope: string, ctx: TokenEncryptionContext): Promise<string> {
    return this.encrypt(await this.decrypt(envelope, ctx), ctx);
  }
}

export class SharedKekError extends Error {}

/**
 * Dev-only shared KEK (INTEGRATIONS_TOKEN_KEK) used by apps/api and apps/worker so both can open the same token
 * envelopes. Unset/blank → undefined. Set but not canonical base64 of exactly 32 bytes → throws. Set while
 * NODE_ENV=production → throws (production must use the ADR-008 secret manager). Errors name the variable only.
 */
export function parseSharedKek(env: NodeJS.ProcessEnv): Buffer | undefined {
  const raw = env.INTEGRATIONS_TOKEN_KEK;
  if (raw === undefined || raw.trim() === '') return undefined;
  if (env.NODE_ENV === 'production')
    throw new SharedKekError(
      'INTEGRATIONS_TOKEN_KEK is dev-only and is refused when NODE_ENV=production',
    );
  const v = raw.trim();
  // 32 bytes = 43 base64 chars + one '=' pad; round-trip rejects non-canonical trailing bits.
  if (!/^[A-Za-z0-9+/]{43}=$/.test(v))
    throw new SharedKekError('INTEGRATIONS_TOKEN_KEK must be canonical base64 of 32 bytes');
  const buf = Buffer.from(v, 'base64');
  if (buf.length !== 32 || buf.toString('base64') !== v)
    throw new SharedKekError('INTEGRATIONS_TOKEN_KEK must be canonical base64 of 32 bytes');
  return buf;
}
