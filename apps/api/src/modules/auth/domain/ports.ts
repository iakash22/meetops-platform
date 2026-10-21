export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(hash: string, plain: string): Promise<boolean>;
}

export interface TokenService {
  /** Cryptographically random, URL-safe opaque token. */
  generate(): string;
  /** Deterministic one-way hash used for lookup. */
  hash(token: string): string;
}
